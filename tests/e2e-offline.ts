/**
 * Offline end-to-end harness — drives the REAL hook scripts (hooks/recall.ts,
 * hooks/capture.ts) exactly as Cursor invokes them (JSON on stdin, per event),
 * against a FAKE brain. Proves the whole loop is wired: device connect → per-tool
 * credential MINT → recall injection → per-turn capture assembly → deposit with the
 * tool's OWN credential. Unit tests cover the pieces; this covers the seams.
 *
 * Run:  bun run tests/e2e-offline.ts   (exit 0 = all assertions pass)
 */
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const fail = (m: string) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`PASS  ${m}`); passed++; };

const HOOKS = join(import.meta.dir, "..", "hooks");
const home = mkdtempSync(join(tmpdir(), "atlaso-e2e-home-"));
const ws = mkdtempSync(join(tmpdir(), "atlaso-e2e-ws-"));

// ── fake brain ───────────────────────────────────────────────────────────────
type Req = { path: string; auth: string; body: any };
const reqs: Req[] = [];
const VERIFIED = { "x-atlaso-response": "1", "content-type": "application/json" };

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization") || "";
    let body: any = null;
    try { body = await req.json(); } catch { /* GET */ }
    reqs.push({ path: url.pathname, auth, body });

    if (url.pathname === "/v1/device/exchange") {
      // mint a per-tool token ONLY from the shared bearer
      if (auth !== "Bearer shared_bearer") return json({ error: "bad" }, 401);
      return json({ token: `tool_token_${body.tool}` }, 200);
    }
    if (url.pathname === "/v1/entitlement") return json({ multi_tool: true, active_tool: null, needs_reconnect: false }, 200);
    if (url.pathname === "/v1/recall") return json({ results: [{ content: "use pnpm not npm", scope: "personal" }] }, 200);
    if (url.pathname === "/v1/memories" && req.method === "GET") return json({ deposits: [] }, 200);
    if (url.pathname === "/v1/memories/batch") return json({ results: [{ client_id: body.items[0].client_id, status: "added", id: "m1" }] }, 200);
    return json({ error: "not found" }, 404);
  },
});
const base = `http://127.0.0.1:${server.port}`;
function json(obj: any, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: VERIFIED });
}

// ── shared bearer on disk (as `atlaso connect` would leave it) ────────────────
mkdirSync(home, { recursive: true });
writeFileSync(
  join(home, "auth.json"),
  JSON.stringify({ server: base, token: "shared_bearer", user_id: "u1", device_id: "dev1" }),
);

const env = {
  ...process.env,
  ATLASO_GLOBAL_PATH: home,
  ATLASO_SERVER: base,
  ATLASO_NO_CONNECT: "1", // don't spawn a browser connect (already "connected")
  ATLASO_NO_BROWSER: "1",
  ATLASO_ENTITLEMENT_TTL: "0", // always re-verify (deterministic)
};

/** Run a hook script with a payload on stdin, like Cursor does. */
async function runHook(script: string, payload: any): Promise<void> {
  const proc = Bun.spawn(["bun", "run", join(HOOKS, script)], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe", stderr: "pipe", env,
  });
  await proc.exited;
}

const CONV = "conv-abc";

async function main() {
  // 1) sessionStart → recall. Mints the per-tool credential + writes the rules file.
  await runHook("recall.ts", { hook_event_name: "sessionStart", conversation_id: CONV, workspace_roots: [ws] });

  ok(existsSync(join(home, "tools", "cursor.json")), "sessionStart minted the per-tool credential (~/.atlaso/tools/cursor.json)");
  const cred = JSON.parse(readFileSync(join(home, "tools", "cursor.json"), "utf8"));
  ok(cred.token === "tool_token_cursor", "the minted credential is the tool's own token, exchanged from the shared bearer");

  const rulesFile = join(ws, ".cursor", "rules", "atlaso-recall.mdc");
  ok(existsSync(rulesFile), "recall wrote the rules file into <workspace>/.cursor/rules/");
  ok(readFileSync(rulesFile, "utf8").includes("use pnpm not npm"), "the recalled memory appears in the rules file");

  const recallReq = reqs.find((r) => r.path === "/v1/recall");
  ok(!!recallReq && recallReq.auth === "Bearer tool_token_cursor", "recall was made with the per-tool credential, NOT the shared bearer");

  // 2) the turn: beforeSubmitPrompt (user) → afterAgentResponse (assistant) → stop (deposit)
  await runHook("capture.ts", { hook_event_name: "beforeSubmitPrompt", conversation_id: CONV, workspace_roots: [ws], prompt: "We decided to standardize on pnpm for this repo." });
  await runHook("capture.ts", { hook_event_name: "afterAgentResponse", conversation_id: CONV, workspace_roots: [ws], text: "Understood — pnpm it is." });
  await runHook("capture.ts", { hook_event_name: "stop", conversation_id: CONV, workspace_roots: [ws], status: "completed" });

  const batch = reqs.find((r) => r.path === "/v1/memories/batch");
  ok(!!batch, "stop deposited the assembled turn to /v1/memories/batch");
  ok(batch!.auth === "Bearer tool_token_cursor", "the deposit used the per-tool credential");
  const text = batch!.body.items[0].text as string;
  ok(text.includes("pnpm"), "the deposited memory carries the user's decision (assembled from beforeSubmitPrompt)");
  ok(batch!.body.items[0].tags.includes("cursor"), "the memory is tagged for the cursor tool");

  // 3) the stash was consumed — sessionEnd must not double-deposit the same turn
  const before = reqs.filter((r) => r.path === "/v1/memories/batch").length;
  await runHook("capture.ts", { hook_event_name: "sessionEnd", conversation_id: CONV, workspace_roots: [ws], reason: "completed" });
  const after = reqs.filter((r) => r.path === "/v1/memories/batch").length;
  ok(after === before, "sessionEnd did NOT re-deposit — the per-turn stash was consumed by stop");

  console.log(`\n${passed} assertions passed — the offline loop is wired end to end.`);
}

main()
  .catch((e) => fail(String(e)))
  .finally(() => {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
