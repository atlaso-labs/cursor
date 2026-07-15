import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as state from "../lib/state";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atlaso-state-"));
  process.env.ATLASO_GLOBAL_PATH = tmp;
});
afterEach(() => {
  delete process.env.ATLASO_GLOBAL_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

test("default is unverified-linked (never fresh → forces re-verify)", () => {
  const d = state.defaultState();
  expect(d.mode).toBe("linked");
  expect(d.checked_at).toBe(0);
  expect(state.isFresh(d)).toBe(false);
});

test("setLinked / get round-trips and is fresh", () => {
  state.setLinked({ tool: "cursor", device_id: "d" });
  const st = state.get();
  expect(st.mode).toBe("linked");
  expect(state.matches(st, "cursor", "d")).toBe(true);
  expect(state.isFresh(st)).toBe(true);
});

test("matches is identity-scoped (tool + device)", () => {
  state.setLinked({ tool: "cursor", device_id: "d" });
  const st = state.get();
  expect(state.matches(st, "codex", "d")).toBe(false); // other tool
  expect(state.matches(st, "cursor", "other")).toBe(false); // other device
});

test("setLocalOnly records reason + active_tool and preserves `since` on re-write", () => {
  state.setLocalOnly("not_entitled", { active_tool: "codex", tool: "cursor", device_id: "d" });
  const a = state.get();
  expect(a.mode).toBe("local_only");
  expect(a.reason).toBe("not_entitled");
  expect(a.active_tool).toBe("codex");
  state.setLocalOnly("not_entitled", { active_tool: "codex", tool: "cursor", device_id: "d" });
  expect(state.get().since).toBe(a.since); // same reason+identity → since preserved
});

test("invalidate drops the verdict back to default", () => {
  state.setLinked({ tool: "cursor", device_id: "d" });
  state.invalidate();
  expect(state.get().checked_at).toBe(0);
});

test("honors the ATLASO_STATE override path (atomic write in its own dir)", () => {
  const other = mkdtempSync(join(tmpdir(), "atlaso-stateovr-"));
  process.env.ATLASO_STATE = join(other, "verdict.json");
  try {
    state.setLinked({ tool: "cursor", device_id: "d" });
    expect(existsSync(join(other, "verdict.json"))).toBe(true);
    expect(state.get().mode).toBe("linked");
  } finally {
    delete process.env.ATLASO_STATE;
    rmSync(other, { recursive: true, force: true });
  }
});
