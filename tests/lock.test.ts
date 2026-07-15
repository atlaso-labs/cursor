import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withToolLock } from "../lib/lock";

let tmp: string;
let lockPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atlaso-lock-"));
  lockPath = join(tmp, "cursor.lock");
  process.env.ATLASO_LOCK_TIMEOUT_MS = "150"; // a contended acquire gives up fast in tests
});
afterEach(() => {
  delete process.env.ATLASO_LOCK_TIMEOUT_MS;
  rmSync(tmp, { recursive: true, force: true });
});

describe("withToolLock (bun:ffi flock)", () => {
  test("grants the lock and reports held:true on a free file", async () => {
    const held = await withToolLock(lockPath, async (h) => h);
    expect(held).toBe(true);
  });

  test("creates but NEVER unlinks the lock file", async () => {
    await withToolLock(lockPath, async () => {});
    expect(existsSync(lockPath)).toBe(true); // left in place — deleting it is a race
  });

  test("a second acquirer is denied while the first holds it (held:false), then granted after release", async () => {
    const [outerHeld, innerHeld] = await withToolLock(lockPath, async (h1) => {
      // nested acquire on the SAME path, while h1 is still held → must be denied
      const inner = await withToolLock(lockPath, async (h2) => h2);
      return [h1, inner] as const;
    });
    expect(outerHeld).toBe(true);
    expect(innerHeld).toBe(false); // contended → caller falls back to the shared bearer
    // once released, it can be taken again
    expect(await withToolLock(lockPath, async (h) => h)).toBe(true);
  });

  test("releases the lock even when the callback throws", async () => {
    await expect(withToolLock(lockPath, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // lock was released in finally → a fresh acquire succeeds
    expect(await withToolLock(lockPath, async (h) => h)).toBe(true);
  });
});
