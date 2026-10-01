#!/usr/bin/env bun
/**
 * capture hook — save the just-finished exchange. Event-routed, because no single
 * Cursor hook payload carries a whole turn (see lib/pending.ts):
 *   • beforeSubmitPrompt → stash the USER prompt (the confirmed source of user text)
 *   • afterAgentResponse → stash the ASSISTANT reply (best-effort enrichment)
 *   • stop / sessionEnd  → assemble the stash (+ payload/transcript fallback), run
 *                          the worth-keeping gate ON THE USER MESSAGE, SCRUB secrets
 *                          client-side, tag scope + project, and deposit with a
 *                          content-derived client_id so stop + sessionEnd of the same
 *                          turn DEDUPE server-side.
 * ZERO model involvement. Online-first: with no token / not cloud-linked we skip.
 * Never breaks the session (always exits 0).
 */
// deadline first: its start time is the hook's start time (rung "hooks never hang").
import { armHardExit } from "../lib/deadline";
import { depositDetailed, loadAuth, type DepositItem } from "../lib/atlaso";
import { drainIfPending } from "../lib/drain";
import { enqueue, promote, quarantine, resolveStaged, settle, stage, unstage } from "../lib/outbox";
import {
  buildContent, classifyScope, heuristicPolarity, messageKey, scrub, shouldDeposit, turnKey,
} from "../lib/capture";
import { resolveCredential } from "../lib/credential";
import { online } from "../lib/entitlement";
import { log } from "../lib/log";
import {
  clearPending, peekPending, stashCompleted, stashPrompt, stashResponse, takeCompleted,
} from "../lib/pending";
import { projectResolution, workspaceRoot } from "../lib/project";
import { parsePayload, readStdin } from "../lib/stdin";
import { exchangeFromPayload, lastExchangeFromFile } from "../lib/transcript";

const TOOL = "cursor";
/** Hook budgets: the stash events are local-only; stop/sessionEnd deposit over the network. */
const STASH_BUDGET_MS = 1000;
/** ATLASO_CURSOR_HOOK_BUDGET_MS (shared with recall) exists for tests and support only. */
const DEPOSIT_BUDGET_MS = Number(process.env.ATLASO_CURSOR_HOOK_BUDGET_MS) || 8000;

const convId = (payload: Record<string, any>): string =>
  String(payload?.conversation_id || payload?.conversationId || "default");

/** The stop/sessionEnd path: assemble the turn and deposit it. */
async function depositTurn(payload: Record<string, any>, event: string): Promise<void> {
  const conversation = convId(payload);
  // Completion receipts are separate from the pending-turn path, so a next prompt
  // can never overwrite one and then be mistaken for the earlier stopped turn.
  const completed = event === "sessionEnd" ? takeCompleted(conversation) : null;
  // Peek first. A stop consumes the prompt only after its content-free completion
  // receipt is durable, so an early failure leaves sessionEnd a recovery path.
  const pending = peekPending(conversation);

  // Resolve the event's own turn independently from the pending stash. When both a
  // prior stop receipt and a newer pending prompt exist, hashes tell us whether this
  // sessionEnd is retrying the stopped turn or closing the newer one.
  let [eventUser, eventAsst] = exchangeFromPayload(payload);
  if (!eventUser && !eventAsst) {
    [eventUser, eventAsst] = lastExchangeFromFile(payload.transcript_path || "");
  }
  let user = "";
  let asst = "";
  let pendingSelected = false;
  let completedSelected = false;
  if (completed) {
    const eventHash = eventUser ? messageKey(scrub(eventUser)[0]) : "";
    const pendingHash = pending?.user ? messageKey(scrub(pending.user)[0]) : "";
    if (eventHash && eventHash === completed.user_hash) {
      user = eventUser;
      asst = eventAsst;
      completedSelected = true;
    } else if (pending && eventHash && eventHash === pendingHash) {
      user = pending.user;
      asst = pending.asst || eventAsst;
      pendingSelected = true;
    } else {
      // A receipt makes this a retry path. Fail closed unless the event identifies
      // either that stopped turn or a newer prompt we actually observed locally.
      log("capture", "skip (ambiguous sessionEnd turn)");
      return;
    }
  } else if (pending) {
    user = pending.user;
    asst = pending.asst || eventAsst;
    pendingSelected = true;
  } else {
    user = eventUser;
    asst = eventAsst;
  }

  // worth-keeping gate on the USER message only (matches the Python client).
  if (!shouldDeposit(user)[0]) {
    // A stop deliberately leaves the stash for sessionEnd until a receipt exists.
    // sessionEnd is the final gate decision and can discard a non-durable turn.
    if (event !== "stop" && pendingSelected) clearPending(conversation);
    log("capture", "skip (gate)");
    return;
  }

  // scrub BOTH sides client-side so secrets never leave the machine.
  const scrubbedUser = scrub(user)[0];
  const content = buildContent(scrubbedUser, scrub(asst)[0]);
  if (!content) return;

  // Project resolution prefers the workspace captured at prompt time (stashed),
  // falling back to this payload's workspace_roots — both scope to the same repo.
  const ws = pending?.ws || workspaceRoot(payload);
  let scope = classifyScope(user);
  // TRI-STATE project attribution (in lockstep with the Python client's core.py).
  // Only resolve a key when the heuristic says "project": 'ok' → tag the key;
  // 'none' (root is $HOME etc.) → genuinely personal, downgrade; 'unknown' (the
  // hook's own vendored runtime, a cache dir, an all-garbage workspace chain) →
  // keep scope:project but attach a bare marker and NEVER a key, so an
  // unattributable capture is visible-with-provenance instead of silently buried
  // under a junk project.
  let pk: string | null = null;
  let projectUnknown = false;
  if (scope === "project") {
    const { status, key } = ws
      ? projectResolution(ws)
      : { status: "unknown" as const, key: null };
    if (status === "none") scope = "personal";
    else if (status === "unknown") projectUnknown = true;
    else pk = key;
  }
  let clientId = turnKey(scrubbedUser, scope, scope === "project" ? pk : null);
  // sessionEnd may reconstruct the same turn from a transcript whose workspace
  // differs from the prompt-time root. Its matching receipt preserves the stop
  // attribution and idempotency key.
  if (completedSelected && completed) {
    scope = completed.scope;
    pk = completed.project;
    clientId = completed.client_id;
  }
  const tags = ["cursor", "auto", `pol-hint:${heuristicPolarity(user)}`, `scope:${scope}`];
  if (projectUnknown) tags.push("project-unknown"); // provenance, never a key
  if (scope === "project" && pk) tags.push(`project:${pk}`);

  const item: DepositItem = {
    client_id: clientId,
    text: content,
    polarity: "open",
    evidence_grade: "anecdotal",
    scope_note: null,
    tags,
  };
  if (event === "stop") {
    // Write before the network call so sessionEnd can safely retry a timed-out or
    // interrupted stop with the same idempotency key and project attribution.
    const receiptSaved = stashCompleted(conversation, {
      user_hash: messageKey(scrubbedUser),
      client_id: clientId,
      scope,
      project: scope === "project" ? pk : null,
      ts: Date.now(),
    });
    if (!receiptSaved) {
      log("capture", "skip (completion receipt unavailable)");
      return;
    }
  }

  const auth = loadAuth(); // local file read, no network
  if (!auth) {
    // Online-first: a signed-out device keeps nothing. Same decision as before this rung.
    if (pendingSelected) clearPending(conversation);
    log("capture", "skip (no auth — online-first)");
    return;
  }
  // WRITE-AHEAD, FIRST, INTO THE STAGED AREA. The turn is on disk (fsynced, atomic rename)
  // before any network call and before the pending stash is cleared, so the hard exit (8 s)
  // during entitlement or credential resolution below cannot lose it (CodeRedTeam 580c16b5).
  // It is NOT in the outbox yet: the outbox is drainable by any hook of this tool, and this
  // turn has no upload verdict. Only THIS hook's own allow verdict below promotes it
  // (CodeRedTeam e632b415: a drain in the entitlement gap uploaded a turn the verdict then
  // refused). If this hook dies first, the next hook of this tool decides with its own verdict.
  const staged = stage(TOOL, item);
  // Only a durable copy lets the stash go. If the disk refused, the stash stays for
  // sessionEnd (stop) or is left to go stale, and we still try the network below.
  if (staged && pendingSelected) clearPending(conversation);

  // entitlement gate: don't deposit to the cloud unless this tool is cloud-linked
  // (free plan = 1 active tool/device; enforced client-side).
  if (!(await online(auth, { tool: TOOL, deviceId: auth.device_id ?? null }))) {
    // Local-only is a decision: the staged turn is dropped (this connector keeps no local
    // store, as before this rung) and so are staged turns of hooks that died undecided.
    // Nothing of this turn was ever drainable, so nothing was sent.
    unstage(TOOL, item.client_id);
    resolveStaged(TOOL, null);
    if (pendingSelected) clearPending(conversation);
    log("capture", "skip (not cloud-linked — local-only)");
    return;
  }
  // Deposit with THIS tool's own credential (minted on first run) so the memory is
  // attributed to Cursor. Null = local-only this run (tombstoned/not-entitled) → skip.
  const cred = await resolveCredential(TOOL);
  if (!cred) {
    unstage(TOOL, item.client_id);
    resolveStaged(TOOL, null);
    if (pendingSelected) clearPending(conversation);
    log("capture", "skip (local-only — no tool credential)");
    return;
  }
  // Allowed: record the verdict on the turn and make it drainable, then settle orphans.
  const allow = { at: Date.now(), by: "capture" };
  const queued = staged ? promote(TOOL, item.client_id, allow) : enqueue(TOOL, item, allow);
  resolveStaged(TOOL, allow);

  try {
    const { ok, results, status } = await depositDetailed(cred, [item]);
    if (ok) {
      const verdict = results.find((r) => r.client_id === item.client_id);
      if (verdict && verdict.status !== "invalid") {
        settle(TOOL, item.client_id);
        // The disk refused the write-ahead but the brain has the turn: the stash can go now.
        if (!queued && pendingSelected) clearPending(conversation);
        unstage(TOOL, item.client_id); // promotion failed half-way: the brain has it
      } else if (verdict) {
        quarantine(TOOL, { client_id: item.client_id, item, enqueued_at: Date.now(), attempts: 1 },
                   `server rejected: ${verdict.status}`);
      }
    }
    log("capture", `saved=${ok}${ok ? "" : ` queued (${status || "transport"})`} scope=${scope}`);
  } catch (e) {
    log("capture", `error ${e} (queued)`); // already on disk; the drain retries it
  }

  // Opportunistic catch-up between turns; one readdir when the queue is empty.
  await drainIfPending(TOOL, cred);
}

async function main(): Promise<void> {
  if (process.env.ATLASO_EXTRACTING) return; // never capture our own enrichment
  const payload = parsePayload(await readStdin());
  const event = String(payload?.hook_event_name || "");
  // The stash events are local-only (host allows 10 s); stop/sessionEnd make network calls
  // (host allows 50 s). Past the budget the process exits 0 whatever is in flight: the
  // completion receipt and the staged turn are written synchronously before any network
  // call (entitlement, credential, deposit), so an interrupted run is decided by the next
  // hook's own verdict and retried from the outbox, never lost or duplicated.
  const stash = event === "beforeSubmitPrompt" || event === "afterAgentResponse";
  armHardExit(stash ? STASH_BUDGET_MS : DEPOSIT_BUDGET_MS, TOOL, "capture");

  // Route by event. beforeSubmitPrompt / afterAgentResponse only STASH (fast, no
  // network); the deposit happens once, on stop/sessionEnd.
  if (event === "beforeSubmitPrompt") {
    const [user] = exchangeFromPayload(payload); // reads payload.prompt
    if (user) stashPrompt(convId(payload), user, workspaceRoot(payload));
    log("capture", `stash prompt (${user.length} chars)`);
    return;
  }
  if (event === "afterAgentResponse") {
    const asst = String(payload?.text || "").trim();
    if (asst) stashResponse(convId(payload), asst);
    log("capture", `stash response (${asst.length} chars)`);
    return;
  }
  // stop / sessionEnd (or any other end-of-turn trigger) → deposit.
  await depositTurn(payload, event);
}

main().catch(() => {}).finally(() => process.exit(0));
