/** Rung "hooks never hang": the sessionStart hook delivers context inside its recall budget
 *  and ends at its hard deadline whatever the brain or the outbox drain does.
 *  Real hook process, synthetic Bun.serve brain on 127.0.0.1, synthetic data only. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveToolAuth } from "../lib/atlaso";
import { enqueue } from "../lib/outbox";
import { setLinked } from "../lib/state";

const HOOK = join(import.meta.dir, "..", "hooks", "recall.ts");
const MEMORY = "Synthetic fixture: this project uses pnpm, never npm.";
let TMP: string;
let HOME: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "atlaso-recall-deadline-"));
  HOME = join(TMP, "home");
  mkdirSync(HOME);
  process.env.ATLASO_GLOBAL_PATH = HOME;
});
afterEach(() => {
  delete process.env.ATLASO_GLOBAL_PATH;
});

function link(port: number, queued: boolean): void {
  const auth = { server: `http://127.0.0.1:${port}`, token: "synthetic-token", user_id: "synthetic-user", device_id: "synthetic-device" };
  writeFileSync(join(HOME, "auth.json"), JSON.stringify(auth));
  setLinked({ tool: "cursor", device_id: "synthetic-device" });
  saveToolAuth("cursor", { ...auth, tool: "cursor" });
  if (queued)
    enqueue("cursor", { client_id: "synthetic-q0", text: "synthetic queued note", polarity: "open",
                        evidence_grade: "anecdotal", scope_note: null, tags: [] }, { at: Date.now(), by: "test" });
}

async function runHook(budgetMs: number): Promise<{ ms: number; code: number; out: string }> {
  const ws = join(TMP, "ws");
  mkdirSync(ws, { recursive: true });
  const t0 = performance.now();
  const child = Bun.spawn(["bun", "run", HOOK], {
    env: { ...process.env, ATLASO_GLOBAL_PATH: HOME, ATLASO_NO_BROWSER: "1", ATLASO_NO_CONNECT: "1",
           ATLASO_CURSOR_HOOK_BUDGET_MS: String(budgetMs) },
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  child.stdin.write(JSON.stringify({ workspace_roots: [ws], hook_event_name: "sessionStart" }));
  child.stdin.end();
  const out = await new Response(child.stdout).text();
  const code = await child.exited;
  return { ms: performance.now() - t0, code, out };
}

function skips(): string[] {
  try {
    return readFileSync(join(HOME, "health", "hooks.log"), "utf-8").trim().split("\n").map((l) => l.split(" ").slice(1).join(" "));
  } catch {
    return [];
  }
}

test("context is delivered before a stalled outbox drain, and the hook ends at its deadline", async () => {
  const hang = new Promise<Response>(() => {});
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/recall" || path === "/v1/memories")
        return Response.json({ results: [{ id: "syn-1", content: MEMORY, tags: [] }] });
      return hang; // the drain's deposit (and anything else) never answers
    },
  });
  try {
    link(server.port!, true);
    const r = await runHook(2000);
    expect(r.code).toBe(0);
    expect(r.out).toContain(MEMORY); // written and flushed before the drain started
    expect(r.ms).toBeLessThan(2000 + 1500); // hard deadline + process start, not the 15 s deposit timeout
    expect(r.ms).toBeGreaterThan(1500); // it really waited on the drain until the deadline
    expect(skips()).toContain("cursor start deadline");
  } finally {
    server.stop(true);
  }
}, 20000);

test("a brain that never answers costs the recall budget, not the host's 50 s", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  try {
    link(server.port!, false);
    const r = await runHook(8000);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(MEMORY);
    expect(r.ms).toBeLessThan(2500 + 1500); // recall budget + process start; old code waited 8 s per call
    expect(skips()).toContain("cursor start network_deadline");
  } finally {
    server.stop(true);
  }
}, 20000);
