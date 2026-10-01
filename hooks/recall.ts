#!/usr/bin/env bun
/**
 * recall hook (Cursor sessionStart) — deliver recalled memory as session context.
 *
 * sessionStart has no per-turn query, so we seed a broad recall (recent work /
 * preferences / decisions) plus the latest deposits, de-duplicated, and return them
 * as `additional_context` on stdout. Nothing private is written into the workspace
 * (security batch B1; see lib/render.ts and lib/legacy_rules.ts): older versions'
 * `.cursor/rules/atlaso-recall.mdc` is deleted here, before auth.json is read or any network
 * work starts, also through
 * a link that stays inside the workspace. Also kicks the detached browser-authorize flow
 * on first run. Best-effort; never breaks the session (always exits 0).
 */
// deadline first: its start time is the hook's start time (rung "hooks never hang").
import { armHardExit, NETWORK_BUDGET_MS, RECALL_BUDGET_MS, recordSkip, remaining, within, writeOut } from "../lib/deadline";
import { loadAuth, recall, recent, type Auth, type RecallResult } from "../lib/atlaso";
import { resolveCredential } from "../lib/credential";
import { maybeAutoconnect } from "../lib/connect";
import { drainIfPending } from "../lib/drain";
import { resolveStaged } from "../lib/outbox";
import { cloudMode, online } from "../lib/entitlement";
import { log } from "../lib/log";
import { projectKey, resultVisibleHere, scopeOf, workspaceRoot } from "../lib/project";
import { legacyFileNotice, removeLegacyRules } from "../lib/legacy_rules";
import { noticeFor, renderContext } from "../lib/render";
import { parsePayload, readStdin } from "../lib/stdin";

const TOOL = "cursor";

/** The whole hook, outbox catch-up included; the host (hooks.json) allows 50 s.
 *  ATLASO_CURSOR_HOOK_BUDGET_MS exists for tests and support only. */
const HOOK_BUDGET_MS = Number(process.env.ATLASO_CURSOR_HOOK_BUDGET_MS) || 8000;

const SEED = "recent work decisions preferences conventions gotchas project setup";
const LIMIT = 8;

async function gather(auth: Auth, project: string | undefined): Promise<RecallResult[]> {
  const seen = new Set<string>();
  const out: RecallResult[] = [];
  const add = (r: RecallResult) => {
    const c = (r.content || "").trim();
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(r);
    }
  };
  // server-side project-scoped recall (already filtered by the brain)
  for (const r of await recall(auth, SEED, LIMIT, project)) add(r);
  // fallback: recent deposits are NOT server-filtered, so apply the SAME
  // per-project visibility rule client-side — project A's notes must never leak
  // into project B's session.
  if (out.length < LIMIT) {
    // OVER-FETCH before filtering. /v1/memories is global newest-first, so asking
    // for exactly LIMIT and then dropping foreign-project rows can return NOTHING
    // right after switching projects — a short run of other-project deposits
    // crowds out every visible memory. The MCP `recent` path already over-fetches
    // before the same filter; this hook did not.
    // (Bugbot #157, "Recall recent fallback under-fetches".)
    const fetchLimit = Math.min(200, Math.max(LIMIT * 4, 40));
    for (const r of await recent(auth, fetchLimit)) {
      // SAME predicate the MCP path uses — a row whose scope arrives in a
      // top-level field rather than in tags must not read as personal and
      // leak into another project's session.
      if (!resultVisibleHere(r, project ?? null)) continue;
      if (r.scope === undefined) r.scope = scopeOf(r.tags)[0]; // for the [scope] suffix
      // /v1/memories created_at is the row's INSERTION time (an L2 rewrite's is its
      // rewrite day), not when the note was said: render these lines undated.
      add({ ...r, created_at: null });
      if (out.length >= LIMIT) break;
    }
  }
  return out;
}

async function main(): Promise<void> {
  if (process.env.ATLASO_EXTRACTING) return; // never recall inside our own enrichment
  const payload = parsePayload(await readStdin());
  const ws = workspaceRoot(payload);
  // Delete older versions' recall file FIRST, before auth.json is read, before the
  // authorize flow contacts the server, and before any recall or outbox work: the host
  // kills this hook at its sessionStart deadline, and a blocked auth.json read, a slow
  // brain or a long outbox drain must not leave recalled text in the workspace
  // (B1a gate ce177d97; cleanup-first rung 799d09ed).
  const legacy = ws ? removeLegacyRules(ws) : null;
  maybeAutoconnect("cursor"); // detached browser-authorize on first run; no-op once linked
  if (!ws || !legacy) return;

  // From here on the process ends at HOOK_BUDGET_MS whatever is in flight (exit 0).
  armHardExit(HOOK_BUDGET_MS, TOOL, "start");

  const auth = loadAuth();
  const deviceId = auth?.device_id ?? null;
  let results: RecallResult[] = [];
  let cred: Auth | null = null;
  // entitlement gate: only recall from the cloud when this tool is cloud-linked
  // (free plan = 1 active tool/device; the brain doesn't enforce it — we do).
  // Resolve THIS tool's own credential (mint on first run) and recall with it, so the
  // brain attributes the call to Cursor specifically. Null = must stay local-only this
  // run (tombstoned/not-entitled) → no notes, only a notice. The whole round trip gets
  // NETWORK_BUDGET_MS, cut to what is left of RECALL_BUDGET_MS; a late answer is dropped.
  let late = false;
  const cloud = (async () => {
    if (!auth || !(await online(auth, { tool: TOOL, deviceId: deviceId }))) return null;
    const c = await resolveCredential(TOOL);
    if (!c) return null;
    let found: RecallResult[] = [];
    try {
      found = await gather(c, projectKey(ws) || undefined);
    } catch {
      /* fall through: no notes this session */
    }
    return { cred: c, found };
  })();
  const raced = await within(cloud, Math.min(NETWORK_BUDGET_MS, remaining(RECALL_BUDGET_MS)), null);
  if (raced.done && raced.value) {
    cred = raced.value.cred;
    results = raced.value.found;
  } else if (!raced.done) {
    late = true;
    recordSkip(TOOL, "start", "network_deadline");
  }
  // re-load auth: online() may have retired a revoked token mid-run. The notice
  // (local-only / upgrade / grace) reaches the user at the top of the recalled block.
  const notice = noticeFor(cloudMode(loadAuth(), { tool: TOOL, deviceId: deviceId }));
  const context = renderContext(results, notice, new Date(), legacyHint(legacy.behindLink));
  // Context is handed to the OS BEFORE the outbox catch-up, so the hard exit cannot drop it.
  if (context) await writeOut(JSON.stringify({ additional_context: context }) + "\n");
  log("recall", `delivery=context chars=${context.length} n=${results.length} notice=${notice ? "y" : "n"} legacy_removed=${legacy.removed.length} legacy_behind_link=${legacy.behindLink ? "y" : "n"}${late ? " network=late" : ""}`);
  // THE RECOVERY PATH. If the last session ended while the brain was down (or
  // mid-deploy, or the laptop was offline), those memories are still sitting in
  // the outbox. sessionStart is the right place to catch up: the user is opening
  // a session, not typing, and we already hold a credential. Costs one readdir
  // when the queue is empty, which is the normal case. Bounded by the hard exit;
  // an item cut off mid-send stays queued (enqueue-then-send, idempotent client_id).
  // A turn whose stop hook died before its entitlement verdict is still STAGED (never drainable).
  // This hook holds its own allow verdict for the same tool, re-evaluated just now (`cred` is set
  // only when online() said cloud-linked and a tool credential resolved), so it promotes those.
  if (cred) {
    resolveStaged(TOOL, { at: Date.now(), by: "session_start" }, { adoptLegacy: true });
    await drainIfPending(TOOL, cred);
  }
}

function legacyHint(path: string | null): string {
  return path ? `> **Atlaso** · ${legacyFileNotice(path)} Mention this to the user once, briefly.` : "";
}

main().catch(() => {}).finally(() => process.exit(0));
