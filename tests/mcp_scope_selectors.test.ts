/**
 * TIER A (SecurityEngineer fcf41ff2 S4, CodeRedTeam c2d2ddcc F2): the MCP server names a
 * project only from a valid workspace root the editor supplied, never from the inherited
 * PWD or the process cwd. Drives the real `dispatch` against a loopback fake brain that
 * returns a project's note only when that project is requested. On 03a5e0322 the absent
 * and PWD-only cells sent repo B's key. Synthetic repos and credentials only. Same file in
 * tools/cursor and tools/opencode; restores cwd and env afterwards.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOL = join(import.meta.dir, "..").split("/").pop()!;
const SELECTORS = ["CURSOR_PROJECT_DIR", "CURSOR_WORKSPACE_ROOT", "OPENCODE_PROJECT_DIR",
  "WORKSPACE_FOLDER_PATHS", "ATLASO_CALLER_PWD"];
const OWN_SELECTOR = TOOL === "cursor" ? "CURSOR_PROJECT_DIR" : "OPENCODE_PROJECT_DIR";
const SAVED: Record<string, string | undefined> = {};
for (const k of [...SELECTORS, "PWD", "ATLASO_GLOBAL_PATH", "ATLASO_SERVER"]) SAVED[k] = process.env[k];
const beforeCwd = process.cwd();

const root = mkdtempSync(join(tmpdir(), "grd-04c1b1e7-scope-"));
function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n url = https://synthetic.invalid/team/${name}.git\n`);
  return dir;
}
const repoA = repo("repo-a"), repoB = repo("repo-b");
const aFile = join(root, "a-file.txt");
writeFileSync(aFile, "not a directory");

const { projectKey } = await import("../lib/project");
const keyA = projectKey(repoA)!, keyB = projectKey(repoB)!;
let sent: string | null = null;
let deposited: string[] | null = null;
const note = (id: string, key: string) => ({ id, content: `synthetic ${id} note`, tags: ["scope:project", `project:${key}`] });
const server = Bun.serve({ port: 0, async fetch(req) {
  const u = new URL(req.url);
  let body: any = {};
  if (u.pathname === "/v1/entitlement") body = { multi_tool: true, active_tool: null, needs_reconnect: false };
  if (u.pathname === "/v1/recall") {
    sent = u.searchParams.get("project");
    body = { results: [{ id: "personal", content: "synthetic personal note", tags: ["scope:personal"] },
      ...(sent === keyA ? [note("repo-a", keyA)] : []), ...(sent === keyB ? [note("repo-b", keyB)] : [])] };
  }
  if (u.pathname === "/v1/memories") body = { deposits: [
    { id: "personal", content: "synthetic personal note", tags: ["scope:personal"] }, note("repo-a", keyA), note("repo-b", keyB)] };
  if (u.pathname === "/v1/memories/batch") {
    deposited = ((await req.json()) as any).items?.[0]?.tags ?? null;
    body = { ids: ["synthetic-id"], results: [{ id: "synthetic-id", status: "stored" }] };
  }
  return Response.json(body, { headers: { "x-atlaso-response": "1" } });
} });
const base = `http://127.0.0.1:${server.port}`, home = join(root, "atlaso");
mkdirSync(join(home, "tools"), { recursive: true });
writeFileSync(join(home, "auth.json"), JSON.stringify({ server: base, token: "synthetic-shared", user_id: "synthetic-grd", device_id: "synthetic-device" }));
writeFileSync(join(home, "tools", `${TOOL}.json`), JSON.stringify({ server: base, token: "synthetic-tool", user_id: "synthetic-grd", device_id: "synthetic-device", tool: TOOL }));
process.env.ATLASO_GLOBAL_PATH = home;
process.env.ATLASO_SERVER = base;
const { dispatch } = await import("../lib/mcp");
const { currentProjectKey } = await import("../lib/project");

afterAll(() => {
  server.stop(true);
  process.chdir(beforeCwd);
  for (const [k, v] of Object.entries(SAVED)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

/** Launch context: process cwd and inherited PWD both repo B, no editor selector. */
beforeEach(() => {
  for (const k of SELECTORS) delete process.env[k];
  process.chdir(repoB);
  process.env.PWD = repoB;
  sent = null;
  deposited = null;
});

async function recallIds(): Promise<string[]> {
  const out = await dispatch("recall", { query: "synthetic note", limit: 10 });
  return out.results.map((r: any) => r.id);
}
async function recentIds(): Promise<string[]> {
  const out = await dispatch("recent", { limit: 10 });
  return out.memories.map((r: any) => r.id);
}

describe(`${TOOL} MCP scope comes only from the editor's workspace`, () => {
  test("absent selector, repository cwd and PWD: personal-only", async () => {
    expect(keyA && keyB && keyA !== keyB).toBeTruthy();
    expect(currentProjectKey()).toBeNull();
    expect(await recallIds()).toEqual(["personal"]);
    expect(sent).toBeNull();
    expect(await recentIds()).toEqual(["personal"]);
  });

  test("absent selector, cwd outside any repo, PWD = repo B: personal-only", async () => {
    process.chdir(root);
    expect(currentProjectKey()).toBeNull();
    expect(await recallIds()).toEqual(["personal"]);
    expect(sent).toBeNull();
  });

  for (const [label, value] of [["empty", ""], ["spaces", "   "], ["relative", "repo-b"],
    ["nonexistent", join(root, "missing")], ["a file", aFile], ["leading space", ` ${repoB}`]] as const) {
    test(`invalid selector (${label}) never falls back to cwd/PWD`, async () => {
      process.env[OWN_SELECTOR] = value;
      expect(currentProjectKey()).toBeNull();
      expect(await recallIds()).toEqual(["personal"]);
      expect(sent).toBeNull();
    });
  }

  test("explicit A while cwd and PWD are B: scoped to A, never B", async () => {
    process.env[OWN_SELECTOR] = repoA;
    expect(currentProjectKey()).toBe(keyA);
    expect((await recallIds()).sort()).toEqual(["personal", "repo-a"]);
    expect(sent).toBe(keyA);
    expect((await recentIds()).sort()).toEqual(["personal", "repo-a"]);
  });

  test("workspace folder list names A while cwd is B: scoped to A", async () => {
    process.env.WORKSPACE_FOLDER_PATHS = `${repoA}:${repoB}`;
    expect(currentProjectKey()).toBe(keyA);
    expect(await recallIds()).toContain("repo-a");
    expect(sent).toBe(keyA);
  });

  test("remember without a selector never files under the cwd's project", async () => {
    const out = await dispatch("remember", { text: "run the unit tests before merging", scope: "project" });
    expect(out.saved).toBe(true);
    expect(deposited).toContain("project-unknown");
    expect((deposited ?? []).some((t) => t === `project:${keyB}`)).toBe(false);
  });
});
