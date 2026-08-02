import { afterEach, afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { currentProjectResolution, resultVisibleHere, projectKey, projectResolution, scopeOf, visibleInProject, workspaceRoot } from "../lib/project";

const roots: string[] = [];
function tmproot(): string {
  // realpath the temp dir up front: macOS /var/folders → /private/var/folders, and
  // projectResolution canonicalizes internally, so tests must compare against the
  // canonical form.
  const d = realpathSync(mkdtempSync(join(tmpdir(), "atlaso-proj-")));
  roots.push(d);
  return d;
}
function mkdirp(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("projectKey / projectResolution — git + fallback", () => {
  test("normalizes an scp-style git origin to host/owner/repo", () => {
    const root = tmproot();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:Me/App.git\n');
    expect(projectResolution(root)).toEqual({ status: "ok", key: "github.com/me/app" });
    expect(projectKey(root)).toBe("github.com/me/app");
  });
  test("normalizes an https git origin identically", () => {
    const root = tmproot();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/Me/App\n');
    expect(projectKey(root)).toBe("github.com/me/app");
  });
  test("no git remote → status ok with a stable <name>-<hash>", () => {
    const root = tmproot();
    writeFileSync(join(root, "package.json"), "{}");
    const res = projectResolution(root);
    expect(res.status).toBe("ok");
    expect(res.key).toMatch(/-[0-9a-f]{8}$/);
    expect(projectKey(root)).toBe(res.key); // stable across calls
  });
});

describe("projectResolution — tri-state garbage detection ('unknown')", () => {
  test("plugin-runtime dir (.claude) → unknown, no key", () => {
    const p = mkdirp(join(tmproot(), ".claude", "plugins", "runtime"));
    expect(projectResolution(p)).toEqual({ status: "unknown", key: null });
    expect(projectKey(p)).toBeNull();
  });
  test("marketplace layout (plugins/marketplaces) → unknown", () => {
    const p = mkdirp(join(tmproot(), "plugins", "marketplaces", "atlaso", "runtime"));
    expect(projectResolution(p).status).toBe("unknown");
  });
  test("node_modules territory → unknown", () => {
    const p = mkdirp(join(tmproot(), "proj", "node_modules", "pkg"));
    expect(projectResolution(p).status).toBe("unknown");
  });
  test(".cursor/extensions → unknown", () => {
    const p = mkdirp(join(tmproot(), ".cursor", "extensions", "atlaso.mem"));
    expect(projectResolution(p).status).toBe("unknown");
  });
  test("editor extensions (extensions + Code) → unknown", () => {
    const p = mkdirp(join(tmproot(), "extensions", "Code", "user"));
    expect(projectResolution(p).status).toBe("unknown");
  });
});

describe("projectResolution — genuine no-project ('none')", () => {
  test("HOME itself → none (genuine personal, NOT a junk key)", () => {
    const realHome = tmproot();
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = realHome;
      expect(projectResolution(realHome)).toEqual({ status: "none", key: null });
      expect(projectKey(realHome)).toBeNull();
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});

describe("projectResolution — .cursor/worktrees are REAL user repos ('ok')", () => {
  test(".cursor/worktrees/<repo> with a git remote → ok with the git key", () => {
    const repo = mkdirp(join(tmproot(), ".cursor", "worktrees", "myrepo"));
    mkdirp(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:Me/Wt.git\n');
    expect(projectResolution(repo)).toEqual({ status: "ok", key: "github.com/me/wt" });
  });
});

describe("fallback key — NFC/NFD + case folding (APFS gives back NFD)", () => {
  // Non-existent leaves under a real base: realpathSync throws, so the resolve()'d
  // string reaches fallbackKey unchanged and only the NFC+lowercase folding acts.
  test("NFC and NFD forms of the same name → identical key", () => {
    const base = tmproot();
    const nfd = projectResolution(join(base, "Café-proj")); // e + combining acute
    const nfc = projectResolution(join(base, "Café-proj")); //  é precomposed
    expect(nfd.status).toBe("ok");
    expect(nfd.key).toBe(nfc.key);
  });
  test("case-only difference → identical stable hash suffix", () => {
    const base = tmproot();
    const lower = projectResolution(join(base, "café-proj"));
    const upper = projectResolution(join(base, "CAFÉ-proj"));
    expect(lower.key!.slice(-8)).toBe(upper.key!.slice(-8)); // hash basis is lowercased
  });
});

describe("visibleInProject (per-project isolation)", () => {
  test("personal / untagged is visible everywhere", () => {
    expect(visibleInProject([], "a")).toBe(true);
    expect(visibleInProject(["scope:personal"], "a")).toBe(true);
    expect(visibleInProject(undefined, null)).toBe(true);
  });
  test("project-scoped is visible only in its own project", () => {
    expect(visibleInProject(["scope:project", "project:a"], "a")).toBe(true);
    expect(visibleInProject(["scope:project", "project:a"], "b")).toBe(false); // no cross-project leak
  });
  test("orphan project-scoped (no key) is VISIBLE (fail OPEN — lab ruling)", () => {
    expect(visibleInProject(["scope:project"], "a")).toBe(true);
    expect(visibleInProject(["scope:project", "project-unknown"], "a")).toBe(true);
  });
  test("scope:orphaned (server-side rescue scope) is hidden from normal recall", () => {
    expect(visibleInProject(["scope:orphaned"], "a")).toBe(false);
    expect(visibleInProject(["scope:orphaned"], null)).toBe(false);
  });
});

describe("scopeOf", () => {
  test("parses scope + project key from tags", () => {
    expect(scopeOf(["scope:project", "project:x"])).toEqual(["project", "x"]);
    expect(scopeOf(["foo"])).toEqual(["personal", null]);
    expect(scopeOf(["scope:orphaned"])).toEqual(["orphaned", null]);
  });
});

describe("workspaceRoot — element-wise garbage guarding of the fallback chain", () => {
  test("reads any plausible payload shape", () => {
    expect(workspaceRoot({ workspace_roots: ["/a", "/b"] })).toBe("/a");
    expect(workspaceRoot({ workspaceRoots: ["/w"] })).toBe("/w");
    expect(workspaceRoot({ project: { workspaceRoot: "/b" } })).toBe("/b");
    expect(workspaceRoot({ workspaceRoot: "/c" })).toBe("/c");
    expect(workspaceRoot({ cwd: "/d" })).toBe("/d");
    expect(typeof workspaceRoot({})).toBe("string"); // PWD / cwd fallback
  });
  test("a garbage payload cwd is SKIPPED; the real repo in PWD wins", () => {
    const base = tmproot();
    const garbageCwd = join(base, ".cursor", "extensions", "atlaso"); // plugin territory
    const realRepo = join(base, "myrepo");
    const savedPwd = process.env.PWD;
    try {
      process.env.PWD = realRepo;
      expect(workspaceRoot({ cwd: garbageCwd })).toBe(realRepo);
    } finally {
      if (savedPwd === undefined) delete process.env.PWD;
      else process.env.PWD = savedPwd;
    }
  });
  test("every candidate garbage → null (caller records status 'unknown')", () => {
    const base = tmproot();
    const g1 = mkdirp(join(base, ".cursor", "extensions", "plug")); // exists so chdir works
    const g2 = join(base, "node_modules", "x");
    const savedPwd = process.env.PWD;
    const savedCwd = process.cwd();
    try {
      process.chdir(g1); // process.cwd() candidate is now garbage too
      process.env.PWD = g2;
      expect(workspaceRoot({ cwd: g1 })).toBeNull();
    } finally {
      process.chdir(savedCwd);
      if (savedPwd === undefined) delete process.env.PWD;
      else process.env.PWD = savedPwd;
    }
  });
});

describe("scope precedence (CodeRedTeam crafted-tag inversions)", () => {
  test("is order-independent: orphaned > project > personal", () => {
    // a trailing tag can never WIDEN visibility
    expect(visibleInProject(["scope:project", "project:secret", "scope:personal"], null)).toBe(false);
    expect(visibleInProject(["scope:personal", "scope:project", "project:secret"], "other")).toBe(false);
    expect(visibleInProject(["scope:orphaned", "scope:project", "project:secret"], "secret")).toBe(false);
    expect(scopeOf(["scope:project", "scope:personal"])[0]).toBe("project");
    expect(scopeOf(["scope:personal", "scope:orphaned"])[0]).toBe("orphaned");
  });
});

// ── one visibility predicate, used by every recall path ─────────────────────
// Two copies of this rule is how a cross-project leak got into the sessionStart
// hook while the MCP path was correct. (Bugbot #157.)
describe("resultVisibleHere", () => {
  test("a row whose scope arrives in a FIELD, not tags, must not leak", () => {
    // THE ACTUAL BUG: the project KEY is in tags but `scope:project` is not —
    // some server versions normalize scope into its own field. Reading tags
    // alone, _scope_of sees no scope:project and calls it PERSONAL, so another
    // project's note lands in this project's rules file.
    const row = { scope: "project", tags: ["cursor", "auto", "project:github.com/me/app"] };
    expect(resultVisibleHere(row, "github.com/me/other")).toBe(false); // must NOT leak
    expect(resultVisibleHere(row, "github.com/me/app")).toBe(true); // visible at home
  });

  test("a project row with NO key stays fail-open — visible, never silently buried", () => {
    // Deliberate rule (server _visible_in_project agrees): an unattributable
    // capture is shown with provenance rather than hidden, because hiding is
    // invisible to the user and so can never be corrected.
    const row = { scope: "project", tags: ["cursor", "auto"] };
    expect(resultVisibleHere(row, "github.com/me/other")).toBe(true);
  });

  test("the same row is visible inside its own project when tagged", () => {
    const row = { scope: "project", tags: ["scope:project", "project:github.com/me/app"] };
    expect(resultVisibleHere(row, "github.com/me/app")).toBe(true);
    expect(resultVisibleHere(row, "github.com/me/other")).toBe(false);
  });

  test("personal rows follow the user everywhere", () => {
    expect(resultVisibleHere({ tags: ["scope:personal"] }, "github.com/me/app")).toBe(true);
    expect(resultVisibleHere({ tags: [] }, "github.com/me/app")).toBe(true);
  });

  test("an unattributed project row is visible with provenance, never buried", () => {
    const row = { tags: ["scope:project", "project-unknown"] };
    expect(resultVisibleHere(row, "github.com/me/app")).toBe(true);
  });

  test("missing/odd shapes never throw", () => {
    expect(() => resultVisibleHere({}, null)).not.toThrow();
    expect(() => resultVisibleHere({ tags: undefined }, "x")).not.toThrow();
  });
});

// ── 'none' must only ever come from an editor-supplied workspace ────────────
// The MCP server falls back to cwd, which is often $HOME. $HOME resolves to
// 'none', and 'none' downgrades a memory to personal — visible in every repo
// forever. (Bugbot #157, "Remember mis-tags personal scope", HIGH.)
describe("currentProjectResolution trusts only the editor's workspace", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test("no workspace env → 'unknown', never 'none', even when cwd is $HOME", () => {
    delete process.env.CURSOR_PROJECT_DIR;
    delete process.env.CURSOR_WORKSPACE_ROOT;
    delete process.env.WORKSPACE_FOLDER_PATHS;
    delete process.env.OPENCODE_PROJECT_DIR;
    process.env.PWD = process.env.HOME || homedir();
    expect(currentProjectResolution().status).toBe("unknown");
  });

  test("an editor-supplied $HOME is still a trustworthy 'none'", () => {
    process.env.CURSOR_PROJECT_DIR = process.env.HOME || homedir();
    process.env.OPENCODE_PROJECT_DIR = process.env.HOME || homedir();
    expect(currentProjectResolution().status).toBe("none");
  });
});
