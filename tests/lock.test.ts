import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withToolLock, _resetFlockProbeForTests } from "../lib/lock";

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

// ── portable fallback lock (the Windows path) ────────────────────────────────
// Regression cover for cursor/plugins#157 Bugbot "Lock miss skips tool revoke":
// before this, no-flock platforms got held:false forever, so resolveCredential
// never called /v1/device/exchange and a REMOVED TOOL KEPT SYNCING on Windows.
describe("portable fallback lock (no flock)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atlaso-lock-fb-"));
    process.env.ATLASO_LOCK_NO_FLOCK = "1";
    _resetFlockProbeForTests();
  });
  afterEach(() => {
    delete process.env.ATLASO_LOCK_NO_FLOCK;
    delete process.env.ATLASO_LOCK_STALE_MS;
    delete process.env.ATLASO_LOCK_TIMEOUT_MS;
    _resetFlockProbeForTests();
  });
  const lp = () => join(dir, "cursor.lock");

  test("GRANTS the lock where flock is unavailable — Windows can now mint", async () => {
    const held = await withToolLock(lp(), async (h) => h);
    expect(held).toBe(true); // the whole point: no longer false on Windows
  });

  test("is mutually exclusive — a second holder cannot enter while the first holds", async () => {
    let innerHeld: boolean | null = null as boolean | null;
    process.env.ATLASO_LOCK_TIMEOUT_MS = "150"; // don't wait the full 5s
    await withToolLock(lp(), async (outer) => {
      expect(outer).toBe(true);
      innerHeld = await withToolLock(lp(), async (h) => h);
    });
    expect(innerHeld).toBe(false);
  });

  test("releases on exit so the next run can take it", async () => {
    await withToolLock(lp(), async (h) => h);
    expect(existsSync(lp() + ".excl")).toBe(false); // released, not leaked
    expect(await withToolLock(lp(), async (h) => h)).toBe(true);
  });

  test("releases even when the guarded work THROWS", async () => {
    await expect(
      withToolLock(lp(), async () => {
        throw new Error("exchange blew up");
      }),
    ).rejects.toThrow("exchange blew up");
    expect(existsSync(lp() + ".excl")).toBe(false);
    expect(await withToolLock(lp(), async (h) => h)).toBe(true); // not wedged forever
  });

  test("reclaims a lock orphaned by a process that died mid-exchange", async () => {
    writeFileSync(lp() + ".excl", JSON.stringify({ pid: 999999, at: 0 }));
    process.env.ATLASO_LOCK_STALE_MS = "1"; // everything is stale
    await Bun.sleep(5);
    expect(await withToolLock(lp(), async (h) => h)).toBe(true);
  });

  test("does NOT steal a lock that is merely held, not stale", async () => {
    writeFileSync(lp() + ".excl", JSON.stringify({ pid: 999999, at: Date.now() }));
    process.env.ATLASO_LOCK_STALE_MS = "600000"; // 10 min — this one is fresh
    process.env.ATLASO_LOCK_TIMEOUT_MS = "150";
    expect(await withToolLock(lp(), async (h) => h)).toBe(false);
    expect(existsSync(lp() + ".excl")).toBe(true); // the holder's lock survived
  });

  test("a lock we could not take is never a verdict — fn still runs with held:false", async () => {
    writeFileSync(lp() + ".excl", "{}");
    process.env.ATLASO_LOCK_STALE_MS = "600000";
    process.env.ATLASO_LOCK_TIMEOUT_MS = "100";
    let ran = false;
    const out = await withToolLock(lp(), async (h) => {
      ran = true;
      return h;
    });
    expect(ran).toBe(true); // never-brick: the caller decides, we don't throw
    expect(out).toBe(false);
  });

  test("uses a SEPARATE file from the flock lock so the two never contend", async () => {
    await withToolLock(lp(), async (h) => {
      expect(existsSync(lp() + ".excl")).toBe(true);
      return h;
    });
  });
});
