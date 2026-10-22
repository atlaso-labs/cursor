/**
 * Test isolation (preloaded by bunfig.toml before any test file): HOME, ATLASO_HOME,
 * ATLASO_PATH and ATLASO_GLOBAL_PATH point at a throwaway folder, and so does
 * `os.homedir()`. Bun reads HOME once at startup, so setting it here does not move
 * `homedir()`; the module mock does, for every importer of "node:os" or "os". Code that
 * resolves `~/.atlaso` (auth.json, cache, state) therefore never reaches the developer's
 * own files. The real home comes from the passwd database (REAL_HOME below), so
 * tests/home_guard.test.ts can check against it. Same file in tools/cursor and tools/opencode.
 */
import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(realOs.tmpdir(), "atlaso-synthetic-home-"));
process.env.ATLASO_SYNTHETIC_HOME = home;
process.env.HOME = home;
for (const name of ["ATLASO_HOME", "ATLASO_PATH", "ATLASO_GLOBAL_PATH"]) process.env[name] = join(home, ".atlaso");
for (const name of ["ATLASO_STATE", "ATLASO_CACHE", "ATLASO_TELEMETRY"]) delete process.env[name];
// SecurityEngineer fcf41ff2's scope cell (tests/security_scope.test.ts, kept byte for byte)
// reads the tool under test from SE_TEST_TOOL; this plugin's folder name is that tool.
process.env.SE_TEST_TOOL ??= join(import.meta.dir, "..").split("/").pop()!;

const os = { ...realOs, homedir: () => home };
for (const id of ["node:os", "os"]) mock.module(id, () => ({ ...os, default: os }));

// ── Real-home trap: a test that touches a path under the real home fails. ─────────────
// Every path-taking node:fs / fs/promises function is wrapped; a path under the passwd
// home that is outside the checkout, the temp folder and the bun cache is recorded, and
// the global afterEach below fails the test that touched it.
import { afterEach } from "bun:test";
import * as realFs from "node:fs";
import * as realFsp from "node:fs/promises";
import { resolve } from "node:path";

/** The account's home from the passwd database. Bun's os.homedir() and os.userInfo().homedir
 *  both follow the HOME the process started with, so a suite launched with a synthetic HOME
 *  would otherwise guard the wrong folder; `~user` expansion asks getpwnam instead. */
function passwdHome(): string {
  const r = Bun.spawnSync(["/bin/sh", "-c", 'eval echo "~$(id -un)"'], { env: { PATH: "/usr/bin:/bin" } });
  const h = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  return h.startsWith("/") ? h : realOs.userInfo().homedir;
}
export const REAL_HOME = realFs.realpathSync(passwdHome());
const ALLOWED = [process.cwd(), resolve(import.meta.dir, "..", "..", "..", "..", ".."),
  realOs.tmpdir(), process.env.TMPDIR ?? "", join(REAL_HOME, ".bun")]
  .filter(Boolean).map((p) => { try { return realFs.realpathSync(p); } catch { return p; } });
const under = (p: string, root: string) => p === root || p.startsWith(root.replace(/\/$/, "") + "/");
export const realHomeTouches: string[] = [];

export function realHomeViolation(p: unknown): string | null {
  if (typeof p !== "string" && !(p instanceof URL) && !Buffer.isBuffer(p)) return null;
  const abs = resolve(p instanceof URL ? p.pathname : p.toString());
  if (!under(abs, REAL_HOME) || ALLOWED.some((r) => under(abs, r))) return null;
  return abs;
}

const PATH_FNS = ["openSync", "readFileSync", "writeFileSync", "appendFileSync",
  "mkdirSync", "rmSync", "unlinkSync", "renameSync", "copyFileSync", "chmodSync",
  "open", "readFile", "writeFile", "appendFile", "mkdir", "rm", "unlink", "rename",
  "createReadStream", "createWriteStream"];
function wrap<T extends Record<string, any>>(mod: T): T {
  const out: Record<string, any> = { ...mod };
  for (const name of PATH_FNS) {
    const fn = mod[name];
    if (typeof fn !== "function") continue;
    out[name] = (...args: any[]) => {
      for (const a of args.slice(0, 2)) {
        const hit = realHomeViolation(a);
        if (hit) realHomeTouches.push(`${name} ${hit}`);
      }
      return fn.apply(mod, args);
    };
  }
  return out as T;
}
const fsW = wrap(realFs as any);
const fspW = wrap(realFsp as any);
fsW.promises = fspW;
for (const id of ["node:fs", "fs"]) mock.module(id, () => ({ ...fsW, default: fsW }));
for (const id of ["node:fs/promises", "fs/promises"]) mock.module(id, () => ({ ...fspW, default: fspW }));

afterEach(() => {
  const hits = realHomeTouches.splice(0);
  if (hits.length) throw new Error(`test touched a path under the real home: ${[...new Set(hits)].join(", ")}`);
});
