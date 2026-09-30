/** B1a: the sessionStart hook removes an older version's recall file BEFORE any network work.
 *
 *  The host kills the hook at its deadline (hooks.json: 50 s). If the hook contacts the
 *  brain or drains the outbox before cleanup, a slow brain leaves recalled text in the
 *  workspace, where `git add -A` can stage it (CodeRedTeam gate on 56fd425b9). This test
 *  runs the real hook against a synthetic brain that never answers, SIGKILLs the hook the
 *  moment its FIRST request arrives, and asserts the old file is already gone.
 *  Synthetic data only.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveToolAuth } from "../lib/atlaso";
import { enqueue } from "../lib/outbox";
import { setLinked } from "../lib/state";

const HOOK = join(import.meta.dir, "..", "hooks", "recall.ts");
let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "atlaso-legacy-first-"));
  process.env.ATLASO_GLOBAL_PATH = join(TMP, "home");
  mkdirSync(process.env.ATLASO_GLOBAL_PATH);
});
afterEach(() => {
  delete process.env.ATLASO_GLOBAL_PATH;
});

test("old recall file is gone when the hook is killed at its first network request", async () => {
  const ws = join(TMP, "ws");
  const rules = join(ws, ".cursor", "rules");
  mkdirSync(rules, { recursive: true });
  const legacy = join(rules, "atlaso-recall.mdc");
  writeFileSync(
    legacy,
    "---\ndescription: Atlaso long-term memory recalled for this session\nalwaysApply: true\n---\nSYNTHETIC-PRIVATE-CANARY\n",
  );

  let firstRequest: () => void = () => {};
  const requested = new Promise<void>((r) => (firstRequest = r));
  const hang = new Promise<Response>(() => {}); // the brain never answers
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      firstRequest();
      return hang;
    },
  });
  const home = process.env.ATLASO_GLOBAL_PATH!;
  const auth = {
    server: `http://127.0.0.1:${server.port}`,
    token: "synthetic-token",
    user_id: "synthetic-user",
    device_id: "synthetic-device",
  };
  writeFileSync(join(home, "auth.json"), JSON.stringify(auth));
  setLinked({ tool: "cursor", device_id: "synthetic-device" });
  saveToolAuth("cursor", { ...auth, tool: "cursor" });
  enqueue("cursor", {
    client_id: "synthetic-0",
    text: "synthetic queued 0",
    polarity: "positive",
    evidence_grade: "observed",
    scope_note: null,
    tags: [],
  });

  const child = Bun.spawn(["bun", "run", HOOK], {
    env: { ...process.env, ATLASO_GLOBAL_PATH: home, ATLASO_NO_BROWSER: "1", ATLASO_NO_CONNECT: "1" },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.stdin.write(JSON.stringify({ workspace_roots: [ws] }));
  child.stdin.end();

  const outcome = await Promise.race([
    requested.then(() => "request" as const),
    child.exited.then(() => "exited" as const),
    Bun.sleep(15_000).then(() => "timeout" as const),
  ]);
  child.kill("SIGKILL");
  await child.exited;
  server.stop(true);

  expect(outcome).toBe("request"); // the fixture must actually reach the network path
  expect(existsSync(legacy)).toBe(false);
}, 30_000);
