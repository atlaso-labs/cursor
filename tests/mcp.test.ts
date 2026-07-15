/** MCP server contract tests — drive lib/mcp.ts's `handle()` the way Cursor's MCP
 *  client does (JSON-RPC 2.0), against a fake brain. Proves initialize/tools-list/
 *  tools-call all speak the protocol and route to the real brain functions with the
 *  per-tool credential.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fake brain ────────────────────────────────────────────────────────────────
type Req = { path: string; method: string; auth: string; body: any };
const reqs: Req[] = [];
const VERIFIED = { "x-atlaso-response": "1", "content-type": "application/json" };
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    let body: any = null;
    try { body = await req.json(); } catch { /* GET / DELETE */ }
    reqs.push({ path: url.pathname, method: req.method, auth: req.headers.get("authorization") || "", body });
    const j = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: VERIFIED });
    if (url.pathname === "/v1/entitlement") return j({ multi_tool: true, active_tool: null, needs_reconnect: false });
    if (url.pathname === "/v1/recall") return j({ results: [{ id: "m1", content: "use pnpm not npm" }] });
    if (url.pathname === "/v1/memories" && req.method === "GET") return j({ deposits: [{ id: "m9", content: "recent one" }] });
    if (url.pathname === "/v1/memories/batch") return j({ results: [{ client_id: body.items[0].client_id, status: "added", id: "new1" }] });
    if (url.pathname.startsWith("/v1/memories/") && req.method === "DELETE") return j({ ok: true });
    if (url.pathname === "/v1/health") return j({ fmi: 72, deposit_count: 128 });
    return j({ error: "not found" }, 404);
  },
});
const base = `http://127.0.0.1:${server.port}`;

// ── the cursor tool's OWN credential on disk (skip the mint path) ─────────────
const home = mkdtempSync(join(tmpdir(), "atlaso-mcp-home-"));
mkdirSync(join(home, "tools"), { recursive: true });
writeFileSync(join(home, "auth.json"), JSON.stringify({ server: base, token: "shared_bearer", user_id: "u1", device_id: "d1" }));
writeFileSync(join(home, "tools", "cursor.json"), JSON.stringify({ server: base, token: "tool_token_cursor", user_id: "u1", device_id: "d1", tool: "cursor" }));

process.env.ATLASO_GLOBAL_PATH = home;
process.env.ATLASO_SERVER = base;

// import AFTER env is set (modules read paths lazily, but be safe)
const { handle, TOOLS, dispatch } = await import("../lib/mcp");

beforeEach(() => { reqs.length = 0; });
afterAll(() => { server.stop(true); rmSync(home, { recursive: true, force: true }); });

const call = (name: string, args: any = {}) =>
  handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const payload = (resp: any) => JSON.parse(resp.result.content[0].text);

describe("JSON-RPC handshake", () => {
  test("initialize returns serverInfo 'Atlaso' + tools capability", async () => {
    const r = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(r.result.serverInfo.name).toBe("Atlaso");
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.protocolVersion).toBe("2024-11-05");
  });
  test("initialized notification gets no reply", async () => {
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });
  test("tools/list exposes exactly the 5 memory tools", async () => {
    const r = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(r.result.tools.map((t: any) => t.name).sort()).toEqual(["forget", "recall", "recent", "remember", "status"]);
    expect(TOOLS.length).toBe(5);
  });
  test("unknown method → -32601", async () => {
    const r = await handle({ jsonrpc: "2.0", id: 3, method: "resources/list" });
    expect(r.error.code).toBe(-32601);
  });
  test("unknown notification (no id) is ignored", async () => {
    expect(await handle({ jsonrpc: "2.0", method: "cancelled" })).toBeNull();
  });
});

describe("tools/call routes to the brain with the per-tool credential", () => {
  test("recall hits /v1/recall as the cursor token and returns id+content", async () => {
    const out = payload(await call("recall", { query: "package manager" }));
    expect(out.results[0]).toEqual({ id: "m1", content: "use pnpm not npm" });
    const req = reqs.find((r) => r.path === "/v1/recall")!;
    expect(req.auth).toBe("Bearer tool_token_cursor");
  });
  test("remember posts a batch tagged for cursor and returns the new id", async () => {
    const out = payload(await call("remember", { text: "we deploy on Fridays" }));
    expect(out).toEqual({ saved: true, id: "new1" });
    const req = reqs.find((r) => r.path === "/v1/memories/batch")!;
    expect(req.body.items[0].tags).toContain("cursor");
    expect(req.auth).toBe("Bearer tool_token_cursor");
  });
  test("recent lists newest-first deposits", async () => {
    const out = payload(await call("recent", { limit: 5 }));
    expect(out.memories[0].id).toBe("m9");
  });
  test("forget deletes by id", async () => {
    const out = payload(await call("forget", { id: "m1" }));
    expect(out).toEqual({ forgotten: true, id: "m1" });
    expect(reqs.some((r) => r.method === "DELETE" && r.path === "/v1/memories/m1")).toBe(true);
  });
  test("status reports fmi + total", async () => {
    const out = payload(await call("status"));
    expect(out).toEqual({ connected: true, fmi: 72, total: 128 });
  });
  test("unknown tool → isError result the model can read", async () => {
    const r = await call("teleport", {});
    expect(r.result.isError).toBe(true);
    expect(payload(r).error).toContain("unknown tool");
  });
});

describe("not-linked path", () => {
  test("dispatch surfaces a friendly error when no credential resolves", async () => {
    // point at a home with NO tools/cursor.json AND no shared bearer → resolveCredential returns null
    const empty = mkdtempSync(join(tmpdir(), "atlaso-mcp-empty-"));
    const prev = process.env.ATLASO_GLOBAL_PATH;
    process.env.ATLASO_GLOBAL_PATH = empty;
    try {
      const out = await dispatch("status", {});
      expect(out.error).toContain("isn't linked");
    } finally {
      process.env.ATLASO_GLOBAL_PATH = prev;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("revoked tombstone (never resurrect via MCP)", () => {
  test("a revoked tool returns 'removed' and NEVER calls the brain on the shared bearer", async () => {
    // The bug this guards: the hooks gate on online() before minting, but the MCP path
    // used to call resolveCredential() directly — so a revoked tool could ride the
    // shared bearer through an MCP call. Persist a VERIFIED revoked verdict (as a prior
    // data-plane 403 would) and prove dispatch() stays local-only.
    const rvHome = mkdtempSync(join(tmpdir(), "atlaso-mcp-revoked-"));
    writeFileSync(join(rvHome, "auth.json"), JSON.stringify({ server: base, token: "shared_bearer", user_id: "u1", device_id: "d1" }));
    const prev = process.env.ATLASO_GLOBAL_PATH;
    process.env.ATLASO_GLOBAL_PATH = rvHome;
    const st = await import("../lib/state");
    st.setLocalOnly(st.REVOKED, { tool: "cursor", device_id: "d1" });
    reqs.length = 0;
    try {
      const out = await dispatch("recall", { query: "anything" });
      expect(out.error).toContain("removed");
      expect(reqs.some((r) => r.path === "/v1/recall")).toBe(false); // never hit the brain
      expect(reqs.some((r) => r.path === "/v1/device/exchange")).toBe(false); // never tried to mint
    } finally {
      process.env.ATLASO_GLOBAL_PATH = prev;
      rmSync(rvHome, { recursive: true, force: true });
    }
  });
});
