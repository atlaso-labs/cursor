/** Rung "hooks never hang" round 3 (CodeRedTeam e632b415, Tier A privacy): a turn is never in a
 *  drainable place before the capturing hook's own entitlement verdict allows upload.
 *
 *  P1 is CodeRedTeam's schedule: the stop hook writes the turn, then waits on /v1/entitlement;
 *  in that gap another drain runs for the same tool; then the verdict comes back local-only.
 *  Round 2 (8c8774a45) put the turn in the outbox before the verdict, so the drain uploaded text
 *  the verdict then refused. Real hook process, synthetic Bun.serve brain on 127.0.0.1, synthetic
 *  data only. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Auth, DepositItem } from "../lib/atlaso";
import { drain } from "../lib/drain";
import * as outbox from "../lib/outbox";

const HOOK = join(import.meta.dir, "..", "hooks", "capture.ts");
const RECALL = join(import.meta.dir, "..", "hooks", "recall.ts");
const MARK = "synthetic-staged-91b4";
const PROMPT = `Remember: this project deploys with pnpm and never npm (${MARK}).`;
let TMP: string;
let HOME: string;
let WS: string;
const savedEnv = process.env.ATLASO_GLOBAL_PATH;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "atlaso-capture-staged-"));
  HOME = join(TMP, "home");
  WS = join(TMP, "ws");
  mkdirSync(HOME);
  mkdirSync(WS);
  process.env.ATLASO_GLOBAL_PATH = HOME; // the in-process drain reads the same device dir
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.ATLASO_GLOBAL_PATH;
  else process.env.ATLASO_GLOBAL_PATH = savedEnv;
});

function seed(port: number): Auth {
  const auth = { server: `http://127.0.0.1:${port}`, token: "synthetic-token", user_id: "synthetic-user", device_id: "synthetic-device" };
  writeFileSync(join(HOME, "auth.json"), JSON.stringify(auth));
  return auth;
}

function spawnHook(script: string, event: string, extra: Record<string, unknown>, budgetMs: number) {
  const child = Bun.spawn(["bun", "run", script], {
    env: { ...process.env, ATLASO_GLOBAL_PATH: HOME, ATLASO_NO_BROWSER: "1", ATLASO_NO_CONNECT: "1",
           ATLASO_CURSOR_HOOK_BUDGET_MS: String(budgetMs) },
    stdin: "pipe", stdout: "ignore", stderr: "ignore",
  });
  child.stdin.write(JSON.stringify({ hook_event_name: event, conversation_id: "synthetic-conv", workspace_roots: [WS], ...extra }));
  child.stdin.end();
  return child;
}

/** Every file under the device dir whose bytes carry the synthetic turn (any queue shape). */
function filesWithTurn(dir = HOME): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of existsSync(d) ? readdirSync(d) : []) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (readFileSync(p, "utf-8").includes(MARK)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const outboxFiles = () => filesWithTurn(join(HOME, "outbox"));

test("P1: a drain in the entitlement gap sends nothing, and a local-only verdict keeps nothing to upload", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entitlementAsked = false;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/entitlement") {
        entitlementAsked = true;
        await gate; // held open until the in-gap drain has run
        return Response.json({ multi_tool: false, active_tool: "claude-code" });
      }
      return Response.json({});
    },
  });
  try {
    const auth = seed(server.port!);
    await spawnHook(HOOK, "beforeSubmitPrompt", { prompt: PROMPT }, 8000).exited;
    const stop = spawnHook(HOOK, "stop", { status: "completed" }, 8000);
    // Wait until the stop hook is inside the entitlement call: the turn is written by then.
    const t0 = Date.now();
    while (!entitlementAsked && Date.now() - t0 < 6000) await Bun.sleep(20);
    expect(entitlementAsked).toBe(true);
    expect(filesWithTurn().length).toBeGreaterThan(0); // durable on the device

    const sent: DepositItem[] = [];
    const record = async (_a: Auth, items: DepositItem[]) => {
      sent.push(...items);
      return { ok: true, status: 200, results: items.map((i) => ({ client_id: i.client_id, status: "added" })) } as any;
    };
    await drain("cursor", { ...auth, source: "own" } as Auth, 25, record);
    release();
    await stop.exited;

    expect(sent.filter((i) => i.text.includes(MARK)).length).toBe(0); // round 2: 1 (uploaded, then "withdrawn")
    expect(outboxFiles()).toEqual([]);
  } finally {
    release();
    server.stop(true);
  }
}, 20000);

test("P1b: a hard exit before any verdict leaves the turn staged, and the next sessionStart uploads it exactly once", async () => {
  let slow = true;
  const deposited: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if ((path === "/v1/entitlement" || path === "/v1/device/exchange") && slow) {
        await Bun.sleep(10000); // past the 2 s test budget
      }
      if (path === "/v1/entitlement") return Response.json({ multi_tool: true });
      if (path === "/v1/device/exchange") return Response.json({ token: "synthetic-minted", tool: "cursor" });
      if (path === "/v1/memories/batch") {
        const body = (await req.json()) as { items: DepositItem[] };
        const mine = body.items.filter((i) => i.text.includes(MARK));
        deposited.push(...mine.map((i) => i.client_id));
        return Response.json({ results: body.items.map((i) => ({ client_id: i.client_id, status: "added" })) });
      }
      if (path === "/v1/recall") return Response.json({ results: [] });
      return Response.json({});
    },
  });
  try {
    seed(server.port!);
    await spawnHook(HOOK, "beforeSubmitPrompt", { prompt: PROMPT }, 2000).exited;
    await spawnHook(HOOK, "stop", { status: "completed" }, 2000).exited;
    expect(filesWithTurn().length).toBe(1); // durable, in exactly one place
    expect(outboxFiles()).toEqual([]); // and not drainable: no verdict was ever recorded
    slow = false;
    await spawnHook(RECALL, "sessionStart", {}, 8000).exited;
    await spawnHook(RECALL, "sessionStart", {}, 8000).exited;
    expect(new Set(deposited).size).toBe(1);
    expect(filesWithTurn()).toEqual([]);
  } finally {
    server.stop(true);
  }
}, 30000);

const item = (id: string): DepositItem => ({
  client_id: id, text: `synthetic ${MARK} ${id}`, polarity: "open", evidence_grade: "anecdotal", scope_note: null, tags: ["cursor"],
});
const ALLOW = { at: Date.now(), by: "test" };

test("P3: drain refuses an outbox record without an allow verdict; a hook's allow verdict adopts it", async () => {
  // A record in the pre-round-3 shape (no allow stamp), as released versions left behind.
  const dir = outbox.outboxDir("cursor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "legacyrecord0000000000000000000.json"),
                JSON.stringify({ client_id: "legacy-1", item: item("legacy-1"), enqueued_at: Date.now(), attempts: 0 }));
  const sent: string[] = [];
  const record = async (_a: Auth, items: DepositItem[]) => {
    sent.push(...items.map((i) => i.client_id));
    return { ok: true, status: 200, results: items.map((i) => ({ client_id: i.client_id, status: "added" })) } as any;
  };
  const auth = { server: "http://127.0.0.1:9", token: "t" } as Auth;
  await drain("cursor", auth, 25, record);
  expect(sent).toEqual([]);
  outbox.resolveStaged("cursor", ALLOW); // the save path never adopts (it would read the whole queue)
  await drain("cursor", auth, 25, record);
  expect(sent).toEqual([]);
  outbox.resolveStaged("cursor", ALLOW, { adoptLegacy: true }); // session start does
  await drain("cursor", auth, 25, record);
  expect(sent).toEqual(["legacy-1"]);
});

test("P4: a live peer's staged turn is never promoted under another process's verdict; a dead one's is", () => {
  expect(outbox.stage("cursor", item("live-1"))).toBe(true); // owned by this (live) process
  outbox.resolveStaged("cursor", ALLOW);
  expect(outbox.isQueued("cursor", "live-1")).toBe(false);
  expect(outbox.isStaged("cursor", "live-1")).toBe(true);

  expect(outbox.stage("cursor", item("dead-1"), { pid: 2 ** 22 + 12345 })).toBe(true); // no such process
  outbox.resolveStaged("cursor", ALLOW);
  expect(outbox.isQueued("cursor", "dead-1")).toBe(true);
  expect(outbox.isStaged("cursor", "dead-1")).toBe(false);
  expect(outbox.pending("cursor").find((r) => r.client_id === "dead-1")?.allow?.by).toBe("test");

  // A local-only verdict discards unowned staged turns instead of promoting them.
  expect(outbox.stage("cursor", item("dead-2"), { pid: 2 ** 22 + 12346 })).toBe(true);
  outbox.resolveStaged("cursor", null);
  expect(outbox.isStaged("cursor", "dead-2")).toBe(false);
  expect(outbox.isQueued("cursor", "dead-2")).toBe(false);
});
