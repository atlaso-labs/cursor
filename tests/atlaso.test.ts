import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deposit, loadAuth, recall, type Auth } from "../lib/atlaso";

const realFetch = globalThis.fetch;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atlaso-auth-"));
  process.env.ATLASO_GLOBAL_PATH = tmp;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ATLASO_GLOBAL_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

const AUTH: Auth = { server: "https://brain.test", token: "atl_x" };

// A mock Response with a real headers.get — our brain stamps `x-atlaso-response: 1`
// on EVERY response (via middleware); an edge/WAF page does not. That header is the
// only thing that lets a rejected call retire a credential (never-brick).
function res(status: number, body: any, headers: Record<string, string> = {}): any {
  const h = new Map(Object.entries(headers));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, json: async () => body };
}
const VERIFIED = { "x-atlaso-response": "1" };

describe("loadAuth", () => {
  test("reads {server, token} from ATLASO_GLOBAL_PATH/auth.json", () => {
    writeFileSync(join(tmp, "auth.json"), JSON.stringify({ server: "https://b", token: "atl_t", user_id: "u" }));
    expect(loadAuth()).toMatchObject({ server: "https://b", token: "atl_t", user_id: "u" });
  });
  test("no auth.json → null", () => {
    expect(loadAuth()).toBeNull();
  });
  test("a token-less file → null", () => {
    writeFileSync(join(tmp, "auth.json"), JSON.stringify({ server: "https://b" }));
    expect(loadAuth()).toBeNull();
  });
});

describe("recall / deposit (mocked fetch, fail-open)", () => {
  test("recall returns server results", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: any) => {
      calledUrl = String(url);
      return { ok: true, json: async () => ({ results: [{ content: "use pnpm" }] }) } as any;
    }) as any;
    const res = await recall(AUTH, "prefs", 5, "github.com/me/app");
    expect(res).toEqual([{ content: "use pnpm" }]);
    expect(calledUrl).toContain("/v1/recall?");
    expect(calledUrl).toContain("project=github.com");
  });
  test("recall fails open on a 5xx (transient) and leaves auth.json intact", async () => {
    writeFileSync(join(tmp, "auth.json"), JSON.stringify({ server: "https://b", token: "atl_t" }));
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as any) as any;
    expect(await recall(AUTH, "x")).toEqual([]);
    expect(existsSync(join(tmp, "auth.json"))).toBe(true); // transient → keep the token
  });
  test("a VERIFIED 401 (our brain) retires auth.json so the next session re-authorizes", async () => {
    writeFileSync(join(tmp, "auth.json"), JSON.stringify({ server: "https://b", token: "atl_dead" }));
    globalThis.fetch = (async () => res(401, {}, VERIFIED)) as any;
    expect(await recall(AUTH, "x")).toEqual([]);
    expect(existsSync(join(tmp, "auth.json"))).toBe(false); // renamed away
    expect(existsSync(join(tmp, "auth.json.revoked"))).toBe(true); // recoverable, not deleted
  });
  test("an UNVERIFIED 401/403 (edge/WAF, no x-atlaso-response) NEVER retires — never-brick", async () => {
    writeFileSync(join(tmp, "auth.json"), JSON.stringify({ server: "https://b", token: "atl_live" }));
    globalThis.fetch = (async () => res(403, {}, {})) as any; // Cloudflare-style block, no header
    expect(await recall(AUTH, "x")).toEqual([]);
    expect(existsSync(join(tmp, "auth.json"))).toBe(true); // kept — a WAF page is not a verdict
    expect(existsSync(join(tmp, "auth.json.revoked"))).toBe(false);
  });
  test("recall fails open on a thrown/transport error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as any;
    expect(await recall(AUTH, "x")).toEqual([]);
  });
  test("deposit posts items and returns true on success", async () => {
    let body: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ results: [{ client_id: "c", status: "added", id: "s" }] }) } as any;
    }) as any;
    const ok = await deposit(AUTH, [
      { client_id: "c", text: "t", polarity: "open", evidence_grade: "anecdotal", scope_note: null, tags: ["cursor"] },
    ]);
    expect(ok).toBe(true);
    expect(body.items[0].text).toBe("t");
  });
  test("deposit of an empty batch is a no-op", async () => {
    expect(await deposit(AUTH, [])).toBe(false);
  });
});
