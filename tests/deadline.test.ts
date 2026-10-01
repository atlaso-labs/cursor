/** lib/deadline.ts (rung "hooks never hang"). Identical in the Cursor and OpenCode
 *  connectors; this file is too. Synthetic only: a temp atlaso dir, child bun processes. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSkip, within } from "../lib/deadline";

const LIB = join(import.meta.dir, "..", "lib", "deadline.ts");
const OTHER = join(import.meta.dir, "..", "..", import.meta.dir.includes("/cursor/") ? "opencode" : "cursor", "lib", "deadline.ts");

describe("deadline", () => {
  test("the Cursor and OpenCode copies are byte-identical", () => {
    expect(readFileSync(LIB, "utf-8")).toBe(readFileSync(OTHER, "utf-8"));
  });

  test("within: a late promise is reported as not done", async () => {
    const t0 = Date.now();
    const r = await within(new Promise((res) => setTimeout(() => res(1), 2000)), 100, 0);
    expect(r.done).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await within(Promise.resolve(5), 100, 0)).toEqual({ done: true, value: 5 });
    expect(await within(Promise.reject(new Error("x")), 100, 9)).toEqual({ done: true, value: 9 });
  });

  test("recordSkip writes only content-free tokens, 0600, and rotates", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlaso-deadline-"));
    const prev = process.env.ATLASO_GLOBAL_PATH;
    process.env.ATLASO_GLOBAL_PATH = dir;
    try {
      const f = join(dir, "health", "hooks.log");
      recordSkip("cursor", "start", "network_deadline");
      recordSkip("cursor", "start", "which package manager do we use?");
      expect(readFileSync(f, "utf-8").trim().split(" ").slice(1)).toEqual(["cursor", "start", "network_deadline"]);
      expect(statSync(f).mode & 0o777).toBe(0o600);
      writeFileSync(f, "0 x y z\n".repeat(10000));
      recordSkip("cursor", "capture", "deadline");
      expect(existsSync(`${f}.1`)).toBe(true);
      expect(readFileSync(f, "utf-8").trim().split(" ").slice(1)).toEqual(["cursor", "capture", "deadline"]);
    } finally {
      if (prev === undefined) delete process.env.ATLASO_GLOBAL_PATH;
      else process.env.ATLASO_GLOBAL_PATH = prev;
    }
  });

  test("armHardExit ends a stuck process at its budget with exit 0 and one skip line", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlaso-deadline-"));
    mkdirSync(join(dir, "health"), { recursive: true });
    const script = join(dir, "stuck.ts");
    writeFileSync(script, `import { armHardExit } from ${JSON.stringify(LIB)};\n` +
      `armHardExit(300, "cursor", "capture");\nsetInterval(() => {}, 1000);\n`);
    const t0 = Date.now();
    const p = Bun.spawnSync(["bun", "run", script], { env: { ...process.env, ATLASO_GLOBAL_PATH: dir } });
    expect(p.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(readFileSync(join(dir, "health", "hooks.log"), "utf-8").trim().split(" ").slice(1))
      .toEqual(["cursor", "capture", "deadline"]);
  });
});
