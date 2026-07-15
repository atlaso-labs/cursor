import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey, scopeOf, visibleInProject, workspaceRoot } from "../lib/project";

const roots: string[] = [];
function tmproot(): string {
  const d = mkdtempSync(join(tmpdir(), "atlaso-proj-"));
  roots.push(d);
  return d;
}
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("projectKey", () => {
  test("normalizes an scp-style git origin to host/owner/repo", () => {
    const root = tmproot();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:Me/App.git\n');
    expect(projectKey(root)).toBe("github.com/me/app");
  });
  test("normalizes an https git origin identically", () => {
    const root = tmproot();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/Me/App\n');
    expect(projectKey(root)).toBe("github.com/me/app");
  });
  test("no git remote → stable <name>-<hash>", () => {
    const root = tmproot();
    writeFileSync(join(root, "package.json"), "{}");
    const key = projectKey(root)!;
    expect(key).toMatch(/-[0-9a-f]{8}$/);
    expect(projectKey(root)).toBe(key); // stable across calls
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
  test("orphan project-scoped (no key) is hidden (fail closed)", () => {
    expect(visibleInProject(["scope:project"], "a")).toBe(false);
  });
});

describe("scopeOf / workspaceRoot", () => {
  test("scopeOf parses scope + project key from tags", () => {
    expect(scopeOf(["scope:project", "project:x"])).toEqual(["project", "x"]);
    expect(scopeOf(["foo"])).toEqual(["personal", null]);
  });
  test("workspaceRoot reads any plausible payload shape, else falls back to a cwd", () => {
    expect(workspaceRoot({ workspace_roots: ["/a", "/b"] })).toBe("/a");
    expect(workspaceRoot({ workspaceRoots: ["/w"] })).toBe("/w");
    expect(workspaceRoot({ project: { workspaceRoot: "/b" } })).toBe("/b");
    expect(workspaceRoot({ workspaceRoot: "/c" })).toBe("/c");
    expect(workspaceRoot({ cwd: "/d" })).toBe("/d");
    expect(typeof workspaceRoot({})).toBe("string"); // cwd fallback
  });
});
