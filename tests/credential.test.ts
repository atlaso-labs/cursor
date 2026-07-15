import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recall, toolAuthPath, type Auth } from "../lib/atlaso";
import { resolveCredential } from "../lib/credential";

const realFetch = globalThis.fetch;
let tmp: string;

// Mock Response with real headers.get — the exchange trusts a verdict ONLY when our
// brain's `x-atlaso-response: 1` header is present.
function res(status: number, body: any, headers: Record<string, string> = {}): any {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, json: async () => body };
}
const VERIFIED = { "x-atlaso-response": "1" };

function writeShared() {
  writeFileSync(
    join(tmp, "auth.json"),
    JSON.stringify({ server: "https://brain.test", token: "shared_bearer", user_id: "u1", device_id: "dev1" }),
  );
}

// Write a per-tool credential file (mkdir the tools/ dir first — the real code does
// this via saveToolAuth; tests that pre-seed a credential must create it themselves).
function writeTool(tool: string, cred: Record<string, unknown>) {
  const p = toolAuthPath(tool);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cred));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atlaso-cred-"));
  process.env.ATLASO_GLOBAL_PATH = tmp;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ATLASO_GLOBAL_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveCredential", () => {
  test("not connected (no shared bearer) → null", async () => {
    expect(await resolveCredential("cursor")).toBeNull();
  });

  test("mints a per-tool credential from the shared bearer (verified 200 + token)", async () => {
    writeShared();
    let exchanged = "";
    globalThis.fetch = (async (url: any, init: any) => {
      exchanged = String(url);
      expect(JSON.parse(init.body).tool).toBe("cursor");
      expect(init.headers.Authorization).toBe("Bearer shared_bearer"); // minted FROM the shared bearer
      return res(200, { token: "cursor_own_token" }, VERIFIED);
    }) as any;

    const cred = await resolveCredential("cursor");
    expect(exchanged).toContain("/v1/device/exchange");
    expect(cred).toMatchObject({ token: "cursor_own_token", source: "own", tool: "cursor", device_id: "dev1" });
    // persisted to tools/cursor.json for the fast path next run
    expect(existsSync(toolAuthPath("cursor"))).toBe(true);
    expect(JSON.parse(readFileSync(toolAuthPath("cursor"), "utf8")).token).toBe("cursor_own_token");
  });

  test("fast path: an own credential of the same identity is used WITHOUT a network call", async () => {
    writeShared();
    writeTool("cursor", { server: "https://brain.test", token: "cached_own", user_id: "u1", device_id: "dev1", tool: "cursor" });
    let called = false;
    globalThis.fetch = (async () => { called = true; return res(200, {}, VERIFIED); }) as any;

    const cred = await resolveCredential("cursor");
    expect(called).toBe(false); // no exchange
    expect(cred).toMatchObject({ token: "cached_own", source: "own" });
  });

  test("foreign own credential (different account) is discarded, then re-minted", async () => {
    writeShared();
    // a leftover from a DIFFERENT user/device — must not be reused
    writeTool("cursor", { server: "https://brain.test", token: "stale", user_id: "OTHER", device_id: "OTHER", tool: "cursor" });
    globalThis.fetch = (async () => res(200, { token: "fresh_own" }, VERIFIED)) as any;
    const cred = await resolveCredential("cursor");
    expect(cred).toMatchObject({ token: "fresh_own", source: "own" });
  });

  test("NEVER-BRICK: an unverified failure (5xx / no header) falls back to the shared bearer, mints nothing", async () => {
    writeShared();
    globalThis.fetch = (async () => res(503, {}, {})) as any; // edge/5xx, no x-atlaso-response
    const cred = await resolveCredential("cursor");
    expect(cred).toMatchObject({ token: "shared_bearer", source: "shared" });
    expect(existsSync(toolAuthPath("cursor"))).toBe(false); // did NOT mint on an unverified failure
  });

  test("NEVER-BRICK: a transport error falls back to the shared bearer", async () => {
    writeShared();
    globalThis.fetch = (async () => { throw new Error("offline"); }) as any;
    const cred = await resolveCredential("cursor");
    expect(cred).toMatchObject({ token: "shared_bearer", source: "shared" });
  });

  test("TOMBSTONE: a verified 403 tool_revoked → null (local-only), no fall back, no mint", async () => {
    writeShared();
    globalThis.fetch = (async () => res(403, {}, { ...VERIFIED, "x-atlaso-error": "tool_revoked" })) as any;
    const cred = await resolveCredential("cursor");
    expect(cred).toBeNull(); // stays down — falling back to shared would resurrect a removed tool
    expect(existsSync(toolAuthPath("cursor"))).toBe(false);
  });

  test("NOT-ENTITLED: a verified 409 → null (free plan, another tool owns the slot)", async () => {
    writeShared();
    globalThis.fetch = (async () => res(409, {}, VERIFIED)) as any;
    const cred = await resolveCredential("cursor");
    expect(cred).toBeNull();
    expect(existsSync(toolAuthPath("cursor"))).toBe(false);
  });
});

describe("tool-scoped retirement (via lib/atlaso call())", () => {
  test("a VERIFIED 401 on a call made with the OWN credential retires ONLY tools/cursor.json — never auth.json", async () => {
    writeShared();
    writeTool("cursor", { server: "https://brain.test", token: "own_dead", user_id: "u1", device_id: "dev1", tool: "cursor" });
    globalThis.fetch = (async () => res(401, {}, VERIFIED)) as any;

    const own: Auth = { server: "https://brain.test", token: "own_dead", user_id: "u1", device_id: "dev1", source: "own", tool: "cursor" };
    expect(await recall(own, "x")).toEqual([]);
    expect(existsSync(toolAuthPath("cursor"))).toBe(false); // the per-tool credential is gone
    expect(existsSync(join(tmp, "auth.json"))).toBe(true); // the shared bearer (and other tools) survive
  });
});
