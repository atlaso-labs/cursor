/** Rung "hooks never hang" round 2 (CodeRedTeam 580c16b5): the stop hook writes the turn to the
 *  device BEFORE entitlement, credential or deposit, and clears the pending stash only after that
 *  write. Since round 3 (CodeRedTeam e632b415) that first write is the STAGED area, not the
 *  drainable outbox. A hard exit during a slow entitlement therefore leaves the turn staged, and
 *  a definitive local-only verdict leaves nothing behind. Real hook process, synthetic Bun.serve
 *  brain on 127.0.0.1, synthetic data only. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "hooks", "capture.ts");
const MARK = "synthetic-writeahead-5c1e";
const PROMPT = `Remember: this project deploys with pnpm and never npm (${MARK}).`;
let TMP: string;
let HOME: string;
let WS: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "atlaso-capture-writeahead-"));
  HOME = join(TMP, "home");
  WS = join(TMP, "ws");
  mkdirSync(HOME);
  mkdirSync(WS);
});
afterEach(() => {});

function seed(port: number): void {
  // The shared device bearer only: the hook must resolve entitlement and mint its credential.
  writeFileSync(join(HOME, "auth.json"), JSON.stringify({
    server: `http://127.0.0.1:${port}`, token: "synthetic-token", user_id: "synthetic-user", device_id: "synthetic-device",
  }));
}

async function hook(event: string, extra: Record<string, unknown>, budgetMs: number): Promise<number> {
  const t0 = performance.now();
  const child = Bun.spawn(["bun", "run", HOOK], {
    env: { ...process.env, ATLASO_GLOBAL_PATH: HOME, ATLASO_NO_BROWSER: "1", ATLASO_NO_CONNECT: "1",
           ATLASO_CURSOR_HOOK_BUDGET_MS: String(budgetMs) },
    stdin: "pipe", stdout: "ignore", stderr: "ignore",
  });
  child.stdin.write(JSON.stringify({ hook_event_name: event, conversation_id: "synthetic-conv", workspace_roots: [WS], ...extra }));
  child.stdin.end();
  await child.exited;
  return performance.now() - t0;
}

function outbox(): string[] {
  return files(join(HOME, "outbox", "cursor"));
}

/** Round 3: a turn without an upload verdict waits here, where no drain looks. */
function staged(): string[] {
  return files(join(HOME, "staged", "cursor"));
}

function files(d: string): string[] {
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => readFileSync(join(d, f), "utf-8")) : [];
}

function pendingCount(): number {
  const d = join(HOME, "cursor-pending");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).length : 0;
}

test("a hard exit during a slow entitlement leaves the turn durably staged, not drainable", async () => {
  const deposits: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/entitlement" || path === "/v1/device/exchange") {
        await Bun.sleep(10000); // past the hook budget (2 s override here, 8 s in the product)
        return Response.json({ multi_tool: true, token: "synthetic-minted" });
      }
      if (path === "/v1/memories/batch") {
        const body = (await req.json()) as { items: { client_id: string }[] };
        deposits.push(...body.items.map((i) => i.client_id));
      }
      return Response.json({});
    },
  });
  try {
    seed(server.port!);
    await hook("beforeSubmitPrompt", { prompt: PROMPT }, 2000);
    expect(pendingCount()).toBe(1);
    const ms = await hook("stop", { status: "completed" }, 2000);
    expect(ms).toBeLessThan(8000 + 1500); // the 8 s product budget at most (2 s via the test override)
    const items = staged();
    expect(items.length).toBe(1); // round 1: 0 (the stash was cleared, nothing written yet)
    expect(items[0]).toContain(MARK);
    expect(outbox()).toEqual([]); // round 2 put it in the drainable outbox before any verdict
    expect(pendingCount()).toBe(0); // the stash went only after the durable write
    expect(deposits).toEqual([]);
  } finally {
    server.stop(true);
  }
}, 20000);

test("a definitive local-only verdict keeps nothing to upload later", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/entitlement") return Response.json({ multi_tool: false, active_tool: "claude-code" });
      return Response.json({});
    },
  });
  try {
    seed(server.port!);
    await hook("beforeSubmitPrompt", { prompt: PROMPT }, 8000);
    await hook("stop", { status: "completed" }, 8000);
    expect(outbox()).toEqual([]);
    expect(staged()).toEqual([]);
    expect(pendingCount()).toBe(0);
  } finally {
    server.stop(true);
  }
}, 20000);
