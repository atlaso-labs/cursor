/** The MCP recall and recent tools never hand a stored credential to the model
 *  (rung c16ac87c): every note text is redacted in place, ids are unchanged, and a note
 *  without a credential keeps its bytes. Fake brain; synthetic notes and credentials. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOL = "cursor";
const SENTINELS = [
  "sk-SYNTHc16ac87cCANARYabcdefghij0123",
  "AKIASYNTHC16AC87CXYZ",
  "ghp_SYNTHc16ac87cABCDEFGHIJKLMNOPQRST",
  "sk_test_SYNTHETIC_SECRET_CANARY_4c26fd7d_ONLY",
];
const DIRTY = [
  ...SENTINELS.map((s) => `Deploy note: the key is ${s} and we rotate it monthly.`),
  "config: api_key=synthc16ac87cValue99 in staging",
  "split sk-SYNTHc16ac87c​CANARYabcdefghij0123 token",
];
const MARKERS = [...SENTINELS, "synthc16ac87cValue99", "SYNTHc16ac87cCANARY", "CANARYabcdefghij0123"];
const CLEAN = [
  "Use pnpm, not npm, in this repo.",
  "Commit 3f2a9c1d4e5b6a7f8091a2b3c4d5e6f708192a3b fixed it.",
  "café 東京 \u{1F389} tab\there\nsecond line",
  "café stays NFD",
];
let notes: string[] = DIRTY;

const VERIFIED = { "x-atlaso-response": "1", "content-type": "application/json" };
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const j = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: VERIFIED });
    if (url.pathname === "/v1/entitlement") return j({ multi_tool: true, active_tool: null, needs_reconnect: false });
    if (url.pathname === "/v1/recall") {
      return j({ results: notes.map((content, i) => ({ id: `n${i}`, content, created_at: "2026-09-01T10:00:00+00:00" })) });
    }
    if (url.pathname === "/v1/memories" && req.method === "GET") {
      return j({ deposits: notes.map((content, i) => ({ id: `n${i}`, content, stated_at: "2026-08-01T10:00:00+00:00" })) });
    }
    return j({ error: "not found" }, 404);
  },
});
const base = `http://127.0.0.1:${server.port}`;
const home = mkdtempSync(join(tmpdir(), "atlaso-mcp-redact-"));
mkdirSync(join(home, "tools"), { recursive: true });
writeFileSync(join(home, "auth.json"), JSON.stringify({ server: base, token: "shared_bearer", user_id: "u1", device_id: "d1" }));
writeFileSync(join(home, "tools", `${TOOL}.json`), JSON.stringify({ server: base, token: `tool_token_${TOOL}`, user_id: "u1", device_id: "d1", tool: TOOL }));
process.env.ATLASO_GLOBAL_PATH = home;
process.env.ATLASO_SERVER = base;

const { dispatch } = await import("../lib/mcp");
afterAll(() => { server.stop(true); rmSync(home, { recursive: true, force: true }); });

const leaks = (o: unknown) => MARKERS.filter((m) => JSON.stringify(o).includes(m));

describe("MCP note text is credential-redacted", () => {
  test("recall: no sentinel, ids unchanged, nothing dropped", async () => {
    notes = DIRTY;
    const out = await dispatch("recall", { query: "deploy", limit: 10 });
    expect(leaks(out)).toEqual([]);
    expect(out.results.map((r: any) => r.id)).toEqual(DIRTY.map((_, i) => `n${i}`));
    expect(out.results.every((r: any) => r.content.includes("REDACTED"))).toBe(true);
  });
  test("recent: no sentinel, ids unchanged", async () => {
    notes = DIRTY;
    const out = await dispatch("recent", { limit: 10 });
    expect(leaks(out)).toEqual([]);
    expect(out.memories.map((r: any) => r.id)).toEqual(DIRTY.map((_, i) => `n${i}`));
  });
  test("clean notes are byte-identical", async () => {
    notes = CLEAN;
    expect((await dispatch("recall", { query: "x", limit: 10 })).results.map((r: any) => r.content)).toEqual(CLEAN);
    expect((await dispatch("recent", { limit: 10 })).memories.map((r: any) => r.content)).toEqual(CLEAN);
  });
  test("redactText: non-strings pass through, output is idempotent", async () => {
    const { redactText } = await import("../lib/render");
    for (const v of [null, undefined, "", 7]) expect(redactText(v as any)).toBe(v as any);
    for (const d of DIRTY) {
      const once = redactText(d) as string;
      expect(redactText(once)).toBe(once);
    }
  });
});
