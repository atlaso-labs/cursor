/** Fails if a test run could reach the developer's real home: the preload
 *  (tests/setup-home.ts) must have pointed every home variable, `os.homedir()` and the
 *  plugin's own Atlaso folder at the synthetic home. The real home is the passwd entry
 *  (setup-home.ts `REAL_HOME`), which `$HOME` cannot redirect. */
import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { atlasoDir } from "../lib/atlaso";
import { REAL_HOME } from "./setup-home";

const synthetic = process.env.ATLASO_SYNTHETIC_HOME ?? "";
const real = REAL_HOME; // passwd home, not $HOME (see setup-home.ts)
const under = (p: string, root: string) => p === root || p.startsWith(root + "/");

test("the preload set a synthetic home", () => {
  expect(synthetic).not.toBe("");
  expect(under(realpathSync(synthetic), join_(real, ".atlaso"))).toBe(false);
});

test("os.homedir(), the home variables and atlasoDir() never resolve to the real home", async () => {
  // Other test files point these variables at their own temp folders; what must hold is
  // that none of them, nor the mocked homedir(), lands in the real home.
  const { realHomeViolation } = await import("./setup-home");
  expect(under(realpathSync(homedir()), realpathSync(synthetic))).toBe(true);
  for (const name of ["HOME", "ATLASO_HOME", "ATLASO_PATH", "ATLASO_GLOBAL_PATH"]) {
    const v = process.env[name];
    if (v) expect(realHomeViolation(v)).toBeNull();
  }
  expect(realHomeViolation(atlasoDir())).toBeNull();
  expect(under(atlasoDir(), join_(real, ".atlaso"))).toBe(false);
});

function join_(a: string, b: string): string {
  return a.replace(/\/$/, "") + "/" + b;
}

test("the real-home trap records a touch under the passwd home and nothing under the synthetic one", async () => {
  const { realHomeViolation } = await import("./setup-home");
  expect(realHomeViolation(join_(real, ".atlaso/auth.json"))).toBe(join_(real, ".atlaso/auth.json"));
  expect(realHomeViolation(join_(synthetic, ".atlaso/auth.json"))).toBeNull();
  expect(realHomeViolation(3)).toBeNull();
});
