/** Real stdio transport proof — spawns lib/mcp.ts AS A PROCESS (exactly how Cursor
 * launches it from mcp.json) and speaks newline-delimited JSON-RPC 2.0 over its
 * stdin/stdout against a fake brain. This is the seam mcp.test.ts can't cover:
 * the actual byte stream, framing, and process lifecycle.
 *
 * Run:  bun run tests/mcp-stdio.ts   (exit 0 = pass)
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const fail = (m: string) => { console.error(`✗ ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`PASS  ${m}`); passed++; };

const VERIFIED = { "x-atlaso-response": "1", "content-type": "application/json" };
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    let body: any = null;
    try { body = await req.json(); } catch {}
    const j = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: VERIFIED });
    if (url.pathname === "/v1/entitlement") return j({ multi_tool: true, active_tool: null, needs_reconnect: false });
    if (url.pathname === "/v1/recall") return j({ results: [{ id: "m1", content: "use pnpm not npm" }] });
    if (url.pathname === "/v1/health") return j({ fmi: 72, deposit_count: 128 });
    return j({ error: "nf" }, 404);
  },
});
const base = `http://127.0.0.1:${server.port}`;

const home = mkdtempSync(join(tmpdir(), "atlaso-stdio-home-"));
mkdirSync(join(home, "tools"), { recursive: true });
writeFileSync(join(home, "auth.json"), JSON.stringify({ server: base, token: "shared", user_id: "u1", device_id: "d1" }));
writeFileSync(join(home, "tools", "cursor.json"), JSON.stringify({ server: base, token: "tool_token_cursor", user_id: "u1", device_id: "d1", tool: "cursor" }));

const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "lib", "mcp.ts")], {
  stdin: "pipe", stdout: "pipe", stderr: "inherit",
  env: { ...process.env, ATLASO_GLOBAL_PATH: home, ATLASO_SERVER: base },
});

// Read stdout, dispatch complete JSON lines to whoever's waiting on that id.
const waiters = new Map<number, (v: any) => void>();
(async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      waiters.get(msg.id)?.(msg);
    }
  }
})();

const writer = proc.stdin;
function rpc(id: number, method: string, params?: any): Promise<any> {
  const p = new Promise<any>((res) => waiters.set(id, res));
  writer.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  writer.flush();
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${method}`)), 8000))]) as Promise<any>;
}

async function main() {
  const init = await rpc(1, "initialize", { protocolVersion: "2024-11-05" });
  ok(init.result.serverInfo.name === "atlaso", "initialize → serverInfo.name === 'atlaso' over real stdio");

  const list = await rpc(2, "tools/list");
  ok(list.result.tools.length === 5, "tools/list → 5 tools over real stdio");

  const recall = await rpc(3, "tools/call", { name: "recall", arguments: { query: "pkg manager" } });
  const rOut = JSON.parse(recall.result.content[0].text);
  ok(rOut.results[0].content === "use pnpm not npm", "tools/call recall → brain result over real stdio");

  const status = await rpc(4, "tools/call", { name: "status", arguments: {} });
  const sOut = JSON.parse(status.result.content[0].text);
  ok(sOut.fmi === 72 && sOut.total === 128, "tools/call status → fmi+total over real stdio");

  console.log(`\n${passed} assertions passed — the real MCP stdio server works end to end.`);
}

main()
  .catch((e) => fail(String(e)))
  .finally(() => {
    proc.kill();
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });
