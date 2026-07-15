import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Auth } from "../lib/atlaso";
import { writeAuth } from "../lib/connect";
import { cloudMode, online } from "../lib/entitlement";
import * as state from "../lib/state";

const realFetch = globalThis.fetch;
const AUTH: Auth = { server: "https://brain.test", token: "atl_x" };
let tmp: string;
let calls: string[];

function mockFetch(ent: any, claim?: any) {
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/v1/entitlement")) return { ok: true, status: 200, json: async () => ent } as any;
    if (u.includes("/v1/devices/claim-tool")) return { ok: true, status: 200, json: async () => claim ?? {} } as any;
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }) as any;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atlaso-ent-"));
  process.env.ATLASO_GLOBAL_PATH = tmp;
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ATLASO_GLOBAL_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe("online() entitlement gate", () => {
  test("paid (multi_tool) → online + linked verdict", async () => {
    mockFetch({ multi_tool: true, active_tool: null, needs_reconnect: false });
    expect(await online(AUTH, "cursor", "d")).toBe(true);
    expect(state.get().mode).toBe("linked");
  });

  test("free + open slot → self-claims → online", async () => {
    mockFetch({ multi_tool: false, active_tool: null, needs_reconnect: false }, { active_tool: "cursor", multi_tool: false });
    expect(await online(AUTH, "cursor", "d")).toBe(true);
    expect(calls.some((u) => u.includes("claim-tool"))).toBe(true);
    expect(state.get().mode).toBe("linked");
  });

  test("free + another tool active → LOCAL-ONLY (no cloud)", async () => {
    mockFetch({ multi_tool: false, active_tool: "claude-code", needs_reconnect: false });
    expect(await online(AUTH, "cursor", "d")).toBe(false);
    const st = state.get();
    expect(st.mode).toBe("local_only");
    expect(st.reason).toBe("not_entitled");
    expect(st.active_tool).toBe("claude-code");
  });

  test("verdict is cached — no second network call within TTL", async () => {
    mockFetch({ multi_tool: true });
    await online(AUTH, "cursor", "d");
    const n = calls.length;
    expect(await online(AUTH, "cursor", "d")).toBe(true);
    expect(calls.length).toBe(n); // served from the cached verdict
  });

  test("needs_reconnect → local-only + auth.json retired", async () => {
    writeFileSync(join(tmp, "auth.json"), JSON.stringify({ server: "https://b", token: "t" }));
    mockFetch({ needs_reconnect: true });
    expect(await online(AUTH, "cursor", "d")).toBe(false);
    expect(existsSync(join(tmp, "auth.json"))).toBe(false); // retired → re-authorize next session
  });

  test("a VERIFIED 401 on entitlement → online false + auth.json retired", async () => {
    writeFileSync(join(tmp, "auth.json"), JSON.stringify({ server: "https://b", token: "t" }));
    globalThis.fetch = (async () => ({
      ok: false, status: 401, headers: { get: (k: string) => (k.toLowerCase() === "x-atlaso-response" ? "1" : null) }, json: async () => ({}),
    }) as any) as any;
    calls = [];
    expect(await online(AUTH, "cursor", "d")).toBe(false);
    expect(existsSync(join(tmp, "auth.json"))).toBe(false);
  });

  test("an UNVERIFIED 401 (edge/WAF) → online false but auth.json KEPT — never-brick", async () => {
    writeFileSync(join(tmp, "auth.json"), JSON.stringify({ server: "https://b", token: "t" }));
    globalThis.fetch = (async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) }) as any) as any;
    calls = [];
    expect(await online(AUTH, "cursor", "d")).toBe(false); // no cloud window this turn
    expect(existsSync(join(tmp, "auth.json"))).toBe(true); // but the token is NOT retired
  });

  test("no auth → offline", async () => {
    expect(await online(null, "cursor", "d")).toBe(false);
  });
});

describe("reconnect", () => {
  test("writeAuth invalidates a cached verdict — no stale free pass after re-link", () => {
    state.setLinked({ tool: "cursor", device_id: "d" });
    expect(state.get().mode).toBe("linked");
    writeAuth("https://b", "newtok", "u", "d2");
    expect(state.get().checked_at).toBe(0); // back to default → re-verify next op
  });
});

describe("cloudMode()", () => {
  test("no auth → not_connected", () => {
    expect(cloudMode(null, "cursor", "d").reason).toBe("not_connected");
  });
  test("reports the persisted not_entitled verdict", async () => {
    mockFetch({ multi_tool: false, active_tool: "codex" });
    await online(AUTH, "cursor", "d");
    const m = cloudMode(AUTH, "cursor", "d");
    expect(m.mode).toBe("local_only");
    expect(m.reason).toBe("not_entitled");
  });
});
