/** Cursor cleanup before authentication: the sessionStart hook removes an older version's
 *  recall file BEFORE it reads auth.json or starts the browser-authorize flow.
 *
 *  Two ways the auth step can block or reach the server first (LabDirector 799d09ed):
 *   1. auth.json is a FIFO with no writer, so the synchronous auth.json read in
 *      maybeAutoconnect() (connect.ts hasToken -> atlaso.ts loadAuth) never returns and the
 *      host kills the hook at its 50 s deadline.
 *   2. First run with no credential: maybeAutoconnect() spawns the detached connect flow,
 *      which POSTs /v1/device/start while the hook is still waiting on a stalled stdin.
 *  Both run the real hook. The synthetic brain records, at each request, whether the old
 *  file still exists, so "cleanup before contacting the server" is observed, not inferred.
 *  Synthetic data only; ATLASO_SERVER always points at the local synthetic brain.
 */
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "hooks", "recall.ts");
const CANARY =
  "---\ndescription: Atlaso long-term memory recalled for this session\nalwaysApply: true\n---\nSYNTHETIC-PRIVATE-CANARY\n";
let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "atlaso-cleanup-first-"));
});

type Seen = { path: string; legacyPresent: boolean };

function setup(): { ws: string; home: string; legacy: string } {
  const ws = join(TMP, "ws");
  mkdirSync(join(ws, ".cursor", "rules"), { recursive: true });
  const legacy = join(ws, ".cursor", "rules", "atlaso-recall.mdc");
  writeFileSync(legacy, CANARY);
  const home = join(TMP, "home");
  mkdirSync(home);
  return { ws, home, legacy };
}

/** Synthetic brain: records each request with the legacy file's state AT that moment, then 503s. */
function brain(legacy: string) {
  const seen: Seen[] = [];
  let first: () => void = () => {};
  const requested = new Promise<void>((r) => (first = r));
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      seen.push({ path: new URL(req.url).pathname, legacyPresent: existsSync(legacy) });
      first();
      return new Response("synthetic unavailable", { status: 503 });
    },
  });
  return { server, seen, requested };
}

function hookEnv(home: string, server: string, ws: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  // The auto-connect must be live: drop every opt-out the test runner may carry.
  for (const k of ["CI", "ATLASO_NO_CONNECT", "ATLASO_EXTRACTING", "ATLASO_PATH", "ATLASO_BUN_PATH"]) delete env[k];
  return { ...env, ATLASO_GLOBAL_PATH: home, ATLASO_SERVER: server, ATLASO_NO_BROWSER: "1", PWD: ws };
}

test("FIFO auth.json: old recall file is removed although the auth.json read never returns", async () => {
  const { ws, home, legacy } = setup();
  const fifo = join(home, "auth.json");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const { server } = brain(legacy);

  const child = Bun.spawn(["bun", "run", HOOK], {
    cwd: ws,
    env: hookEnv(home, `http://127.0.0.1:${server.port}`, ws),
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.stdin.write(JSON.stringify({ workspace_roots: [ws] }));
  child.stdin.end();

  // Poll for up to 10 s (well inside the 50 s host deadline) for the old file to go.
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    await Bun.sleep(100);
    gone = !existsSync(legacy);
  }
  // Realizability: the hook must be STUCK on the FIFO (not finished), or the fixture tested nothing.
  const stillRunning = child.exitCode === null;
  child.kill("SIGKILL");
  await child.exited;
  server.stop(true);

  expect(stillRunning).toBe(true);
  expect(gone).toBe(true);
}, 30_000);

test("first run, no credential, stalled stdin: old file is gone before /v1/device/start", async () => {
  const { ws, home, legacy } = setup(); // no auth.json at all: unauthenticated first run
  const { server, seen, requested } = brain(legacy);

  const child = Bun.spawn(["bun", "run", HOOK], {
    cwd: ws, // stdin never arrives, so the workspace comes from PWD / cwd
    env: hookEnv(home, `http://127.0.0.1:${server.port}`, ws),
    stdin: "pipe", // opened and never written or closed: a stalled host
    stdout: "ignore",
    stderr: "ignore",
  });

  const outcome = await Promise.race([
    requested.then(() => "request" as const),
    Bun.sleep(15_000).then(() => "timeout" as const),
  ]);
  child.kill("SIGKILL");
  await child.exited;
  // let the detached connect process see its 503 and exit before the brain stops
  await Bun.sleep(200);
  server.stop(true);

  expect(outcome).toBe("request"); // the fixture must actually reach the authorize flow
  expect(seen[0].path).toBe("/v1/device/start");
  expect(seen[0].legacyPresent).toBe(false);
  expect(existsSync(legacy)).toBe(false);
}, 30_000);
