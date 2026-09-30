/** B1: older versions' recall files are removed from the workspace, only when they are
 * Atlaso's own, through a symbolic link only when it resolves inside the workspace, never
 * creating anything. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insideWorkspace, LEGACY_RECALL_REL, legacyFileNotice, removeLegacyRules } from "../lib/legacy_rules";
import { render } from "../lib/render";

const OLD_RECALL = render([{ content: "SYNTHETIC-PRIVATE-LEGACY" } as any]);
const OLD_NOTICE = "---\ndescription: Atlaso notice, recall is paused in this workspace\nalwaysApply: true\n---\n\n# Atlaso notice\n";
let root: string, ws: string, rules: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlaso-legacy-"));
  ws = join(root, "ws");
  rules = join(ws, ".cursor", "rules");
  mkdirSync(ws, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("removeLegacyRules", () => {
  test("removes Atlaso's recall, notice and temp files; keeps everything else byte-identical", () => {
    mkdirSync(rules, { recursive: true });
    writeFileSync(join(rules, "atlaso-recall.mdc"), OLD_RECALL);
    writeFileSync(join(rules, "atlaso-notice.mdc"), OLD_NOTICE);
    writeFileSync(join(rules, ".atlaso-recall.mdc.123.0123456789ab.tmp"), "SYNTHETIC-PRIVATE-LEGACY");
    writeFileSync(join(rules, ".gitignore"), "/atlaso-recall.mdc\n");
    writeFileSync(join(rules, "team.mdc"), "---\nalwaysApply: true\n---\nteam\n");
    expect(removeLegacyRules(ws)).toEqual({
      removed: [".atlaso-recall.mdc.123.0123456789ab.tmp", "atlaso-notice.mdc", "atlaso-recall.mdc"], behindLink: null,
    });
    expect(readdirSync(rules).sort()).toEqual([".gitignore", "team.mdc"]);
    expect(readFileSync(join(rules, ".gitignore"), "utf8")).toBe("/atlaso-recall.mdc\n");
  });
  test("a same-named file without Atlaso's header is the user's and is kept", () => {
    mkdirSync(rules, { recursive: true });
    writeFileSync(join(rules, "atlaso-recall.mdc"), "---\ndescription: mine\n---\nmine\n");
    writeFileSync(join(rules, ".atlaso-recall.mdc.tmp"), "not our temp shape");
    expect(removeLegacyRules(ws).removed).toEqual([]);
    expect(readFileSync(join(rules, "atlaso-recall.mdc"), "utf8")).toBe("---\ndescription: mine\n---\nmine\n");
    expect(existsSync(join(rules, ".atlaso-recall.mdc.tmp"))).toBe(true);
  });
  test("a symlinked recall file is not followed or removed", () => {
    mkdirSync(rules, { recursive: true });
    const outside = join(root, "outside.mdc");
    writeFileSync(outside, OLD_RECALL);
    symlinkSync(outside, join(rules, "atlaso-recall.mdc"));
    expect(removeLegacyRules(ws).removed).toEqual([]);
    expect(lstatSync(join(rules, "atlaso-recall.mdc")).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe(OLD_RECALL);
  });
  for (const linked of [".cursor", ".cursor/rules"]) {
    test(`nothing is deleted through a symlinked ${linked} that leads outside; the leftover is reported`, () => {
      const target = join(root, "target");
      if (linked === ".cursor") {
        mkdirSync(join(target, "rules"), { recursive: true });
        writeFileSync(join(target, "rules", "atlaso-recall.mdc"), OLD_RECALL);
        symlinkSync(target, join(ws, ".cursor"));
      } else {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "atlaso-recall.mdc"), OLD_RECALL);
        mkdirSync(join(ws, ".cursor"));
        symlinkSync(target, rules);
      }
      expect(removeLegacyRules(ws)).toEqual({ removed: [], behindLink: LEGACY_RECALL_REL });
      const kept = linked === ".cursor" ? join(target, "rules", "atlaso-recall.mdc") : join(target, "atlaso-recall.mdc");
      expect(readFileSync(kept, "utf8")).toBe(OLD_RECALL);
    });
  }
  test("a symlinked rules folder without an Atlaso file is not reported", () => {
    const target = join(root, "target");
    mkdirSync(target);
    writeFileSync(join(target, "atlaso-recall.mdc"), "user file\n");
    mkdirSync(join(ws, ".cursor"));
    symlinkSync(target, rules);
    expect(removeLegacyRules(ws)).toEqual({ removed: [], behindLink: null });
  });
  test("creates nothing when there is no .cursor folder, and survives a missing workspace", () => {
    expect(removeLegacyRules(ws)).toEqual({ removed: [], behindLink: null });
    expect(readdirSync(ws)).toEqual([]);
    expect(removeLegacyRules(join(root, "missing"))).toEqual({ removed: [], behindLink: null });
  });
  test("restores the caller's working directory", () => {
    mkdirSync(rules, { recursive: true });
    writeFileSync(join(rules, "atlaso-recall.mdc"), OLD_RECALL);
    const before = process.cwd();
    removeLegacyRules(ws);
    expect(process.cwd()).toBe(before);
  });
});

describe("links that stay inside the workspace (CodeRedTeam f5332029)", () => {
  const layouts: Array<[string, () => string]> = [
    [".cursor/rules -> ../rules-target (inside)", () => {
      mkdirSync(join(ws, "rules-target"));
      mkdirSync(join(ws, ".cursor"));
      symlinkSync("../rules-target", rules);
      return join(ws, "rules-target");
    }],
    [".cursor -> cursor-shared (inside)", () => {
      mkdirSync(join(ws, "cursor-shared", "rules"), { recursive: true });
      symlinkSync("cursor-shared", join(ws, ".cursor"));
      return join(ws, "cursor-shared", "rules");
    }],
    [".cursor/rules -> docs/a -> docs/rules (chain inside)", () => {
      mkdirSync(join(ws, "docs", "rules"), { recursive: true });
      symlinkSync("rules", join(ws, "docs", "a"));
      mkdirSync(join(ws, ".cursor"));
      symlinkSync("../docs/a", rules);
      return join(ws, "docs", "rules");
    }],
    [".cursor/rules -> .. (the workspace root)", () => {
      mkdirSync(join(ws, ".cursor"));
      symlinkSync("..", rules);
      return ws;
    }],
    [".cursor/rules -> absolute path inside", () => {
      mkdirSync(join(ws, "abs-target"));
      mkdirSync(join(ws, ".cursor"));
      symlinkSync(join(ws, "abs-target"), rules);
      return join(ws, "abs-target");
    }],
  ];
  for (const [name, make] of layouts) {
    test(`removes Atlaso's old files and keeps the rest: ${name}`, () => {
      const target = make();
      writeFileSync(join(target, "atlaso-recall.mdc"), OLD_RECALL);
      writeFileSync(join(target, "atlaso-notice.mdc"), OLD_NOTICE);
      writeFileSync(join(target, "team.mdc"), "team rule\n");
      writeFileSync(join(target, ".gitignore"), "/atlaso-recall.mdc\n");
      expect(removeLegacyRules(ws)).toEqual({ removed: ["atlaso-notice.mdc", "atlaso-recall.mdc"], behindLink: null });
      expect(existsSync(join(target, "atlaso-recall.mdc"))).toBe(false);
      expect(readFileSync(join(target, "team.mdc"), "utf8")).toBe("team rule\n");
      expect(readFileSync(join(target, ".gitignore"), "utf8")).toBe("/atlaso-recall.mdc\n");
      expect(removeLegacyRules(ws)).toEqual({ removed: [], behindLink: null }); // idempotent
    });
  }
  test("a user file of the same name without Atlaso's header, behind an inside link, is kept", () => {
    mkdirSync(join(ws, "rules-target"));
    writeFileSync(join(ws, "rules-target", "atlaso-recall.mdc"), "mine\n");
    mkdirSync(join(ws, ".cursor"));
    symlinkSync("../rules-target", rules);
    expect(removeLegacyRules(ws)).toEqual({ removed: [], behindLink: null });
    expect(readFileSync(join(ws, "rules-target", "atlaso-recall.mdc"), "utf8")).toBe("mine\n");
  });
  test("a hard link inside the target removes only the name; the outside file is unchanged", () => {
    const outside = join(root, "outside-hard.mdc");
    writeFileSync(outside, OLD_RECALL);
    mkdirSync(join(ws, "rules-target"));
    linkSync(outside, join(ws, "rules-target", "atlaso-recall.mdc"));
    mkdirSync(join(ws, ".cursor"));
    symlinkSync("../rules-target", rules);
    expect(removeLegacyRules(ws).removed).toEqual(["atlaso-recall.mdc"]);
    expect(readFileSync(outside, "utf8")).toBe(OLD_RECALL);
  });
});

describe("links that escape the workspace are never followed for a delete", () => {
  const escapes: Array<[string, () => string]> = [
    ["chain: .cursor/rules -> ../a, a -> outside", () => {
      const out = join(root, "outside-chain"); mkdirSync(out);
      symlinkSync(out, join(ws, "a"));
      mkdirSync(join(ws, ".cursor"));
      symlinkSync("../a", rules);
      return out;
    }],
    ["prefix sibling: .cursor/rules -> ../../ws2 (ws2 starts with ws)", () => {
      const out = join(root, "ws2"); mkdirSync(out);
      mkdirSync(join(ws, ".cursor"));
      symlinkSync("../../ws2", rules);
      return out;
    }],
    ["dot-dot through the workspace: .cursor/rules -> ../../ws/../outside-dd", () => {
      const out = join(root, "outside-dd"); mkdirSync(out);
      mkdirSync(join(ws, ".cursor"));
      symlinkSync("../../ws/../outside-dd", rules);
      return out;
    }],
  ];
  for (const [name, make] of escapes) {
    test(name, () => {
      const out = make();
      writeFileSync(join(out, "atlaso-recall.mdc"), OLD_RECALL);
      writeFileSync(join(out, "atlaso-notice.mdc"), OLD_NOTICE);
      expect(removeLegacyRules(ws)).toEqual({ removed: [], behindLink: LEGACY_RECALL_REL });
      expect(readdirSync(out).sort()).toEqual(["atlaso-notice.mdc", "atlaso-recall.mdc"]);
      expect(readFileSync(join(out, "atlaso-recall.mdc"), "utf8")).toBe(OLD_RECALL);
    });
  }
  test("a directory swapped for an outside link between the check and the delete is not entered", () => {
    mkdirSync(rules, { recursive: true });
    writeFileSync(join(rules, "atlaso-recall.mdc"), OLD_RECALL);
    const out = join(root, "outside-race"); mkdirSync(out);
    writeFileSync(join(out, "atlaso-recall.mdc"), OLD_RECALL);
    const realChdir = process.chdir;
    let swapped = false;
    (process as any).chdir = (d: string) => {
      if (!swapped && d.endsWith(join(".cursor", "rules"))) {
        swapped = true;
        renameSync(rules, join(ws, ".cursor", "rules-old"));
        symlinkSync(out, rules);
      }
      return realChdir.call(process, d);
    };
    try {
      expect(removeLegacyRules(ws).removed).toEqual([]);
    } finally {
      (process as any).chdir = realChdir;
    }
    expect(swapped).toBe(true);
    expect(readFileSync(join(out, "atlaso-recall.mdc"), "utf8")).toBe(OLD_RECALL);
  });
  test("a dangling rules link is ignored", () => {
    mkdirSync(join(ws, ".cursor"));
    symlinkSync(join(root, "nowhere"), rules);
    expect(removeLegacyRules(ws)).toEqual({ removed: [], behindLink: null });
  });
});

describe("helpers", () => {
  test("insideWorkspace is a path-component check, not a string prefix", () => {
    expect(insideWorkspace("/a/ws", "/a/ws")).toBe(true);
    expect(insideWorkspace("/a/ws", "/a/ws/x")).toBe(true);
    expect(insideWorkspace("/a/ws", "/a/ws2")).toBe(false);
    expect(insideWorkspace("/a/ws", "/a")).toBe(false);
    expect(insideWorkspace("/", "/x")).toBe(true);
  });
  test("the left-behind notice names the path and one removal step", () => {
    const n = legacyFileNotice(LEGACY_RECALL_REL);
    expect(n).toContain("`.cursor/rules/atlaso-recall.mdc`");
    expect(n).toContain("outside this workspace");
    expect(n).toContain("`rm .cursor/rules/atlaso-recall.mdc`");
  });
});
