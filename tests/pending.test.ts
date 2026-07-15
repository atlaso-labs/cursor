import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stashPrompt, stashResponse, takePending } from "../lib/pending";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atlaso-pending-"));
  process.env.ATLASO_GLOBAL_PATH = tmp;
});
afterEach(() => {
  delete process.env.ATLASO_GLOBAL_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

const pendingFile = (conv: string) => join(tmp, "cursor-pending", `${conv}.json`);

describe("per-turn capture stash", () => {
  test("stash prompt → merge response → take assembles the full exchange", () => {
    stashPrompt("conv1", "use pnpm not npm", "/repo");
    stashResponse("conv1", "Got it, switching to pnpm.");
    const p = takePending("conv1");
    expect(p).toMatchObject({ user: "use pnpm not npm", asst: "Got it, switching to pnpm.", ws: "/repo" });
  });

  test("take DELETES the stash (so stop + sessionEnd don't double-deposit)", () => {
    stashPrompt("conv1", "hello", null);
    expect(existsSync(pendingFile("conv1"))).toBe(true);
    takePending("conv1");
    expect(existsSync(pendingFile("conv1"))).toBe(false);
    expect(takePending("conv1")).toBeNull(); // second take is empty
  });

  test("works on the CONFIRMED fields alone — user prompt with no assistant reply", () => {
    stashPrompt("conv1", "remember: deploy is manual", "/repo");
    const p = takePending("conv1");
    expect(p).toMatchObject({ user: "remember: deploy is manual", asst: "" });
  });

  test("stashResponse without a prior prompt is a no-op (afterAgentResponse before any seen prompt)", () => {
    stashResponse("conv1", "orphan reply");
    expect(takePending("conv1")).toBeNull();
  });

  test("a new prompt starts a fresh turn (replaces a half-built stash)", () => {
    stashPrompt("conv1", "first", "/repo");
    stashResponse("conv1", "first reply");
    stashPrompt("conv1", "second", "/repo"); // new turn
    const p = takePending("conv1");
    expect(p).toMatchObject({ user: "second", asst: "" }); // prior reply dropped
  });

  test("conversations are isolated", () => {
    stashPrompt("convA", "A", "/a");
    stashPrompt("convB", "B", "/b");
    expect(takePending("convA")?.user).toBe("A");
    expect(takePending("convB")?.user).toBe("B");
  });

  test("stale stashes (> 1h) are pruned on the next take", () => {
    stashPrompt("old", "abandoned", "/repo");
    const twoHoursAgo = Date.now() / 1000 - 2 * 3600;
    utimesSync(pendingFile("old"), twoHoursAgo, twoHoursAgo); // age it
    takePending("somethingelse"); // any take triggers a prune
    expect(existsSync(pendingFile("old"))).toBe(false);
  });
});
