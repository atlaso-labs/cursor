import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCredential } from "../lib/credential";
import * as state from "../lib/state";

const realFetch = globalThis.fetch;
let tmp: string;

function response(status: number, cause?: string): any {
  const headers = new Map<string, string>([["x-atlaso-response", "1"]]);
  if (cause) headers.set("x-atlaso-error", cause);
  return {
    ok: false,
    status,
    headers: { get: (key: string) => headers.get(key.toLowerCase()) ?? null },
    json: async () => ({}),
  };
}

function writeShared(): void {
  writeFileSync(join(tmp, "auth.json"), JSON.stringify({
    server: "https://brain.test",
    token: "shared_bearer",
    user_id: "u1",
    device_id: "dev1",
  }));
}

async function resolveWith(status: number, cause?: string) {
  globalThis.fetch = (async () => response(status, cause)) as any;
  return resolveCredential("cursor");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atlaso-ship-c-cursor-"));
  process.env.ATLASO_GLOBAL_PATH = tmp;
  writeShared();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ATLASO_GLOBAL_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe("ship_c_impl header-driven credential refusals", () => {
  test("ship_c_impl_headerless_409_is_transient_not_unselected", async () => {
    expect(await resolveWith(409)).toMatchObject({ token: "shared_bearer", source: "shared" });
    expect(state.get().mode).toBe(state.LINKED);
  });

  test("ship_c_impl_device_cap_retains_credentials_and_does_not_park", async () => {
    expect(await resolveWith(409, "device_limit_reached")).toMatchObject({
      token: "shared_bearer",
      source: "shared",
    });
    expect(existsSync(join(tmp, "auth.json"))).toBe(true);
    expect(state.get().mode).toBe(state.LINKED);
  });

  test("ship_c_impl_unresolved_and_missing_entitlement_retain_credentials", async () => {
    for (const cause of ["plan_unresolved", "entitlement_required"]) {
      expect(await resolveWith(409, cause)).toMatchObject({
        token: "shared_bearer",
        source: "shared",
      });
      expect(existsSync(join(tmp, "auth.json"))).toBe(true);
      expect(state.get().mode).toBe(state.LINKED);
    }
  });

  test("ship_c_impl_only_unselected_tool_is_soft_parked", async () => {
    for (const [status, cause] of [[403, "not_entitled"], [409, "tool_switch_needed"]] as const) {
      state.invalidate();
      expect(await resolveWith(status, cause)).toBeNull();
      expect(state.get()).toMatchObject({ mode: state.LOCAL_ONLY, reason: state.NOT_ENTITLED });
      expect(existsSync(join(tmp, "auth.json"))).toBe(true);
    }
  });

  test("ship_c_impl_credential_revoked_tombstones_the_tool", async () => {
    expect(await resolveWith(409, "credential_revoked")).toBeNull();
    expect(state.get()).toMatchObject({ mode: state.LOCAL_ONLY, reason: state.REVOKED });
    expect(existsSync(join(tmp, "auth.json"))).toBe(true);
  });
});
