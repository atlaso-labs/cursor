/**
 * B1 round 2: ordinary notes keep their exact pre-B1 bytes in Cursor's recalled block.
 * The pre-B1 (control 776c3c73b) clean() is frozen below verbatim and compared with the
 * real render() over the synthetic benign corpus shared with the Python and OpenCode
 * suites (client/tests/fixtures/benign_corpus.json). Only documented differences are
 * allowed: a CRLF note used to carry a raw CR (a line terminator for many readers); now
 * CRLF is one break like LF.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "../lib/render";

const CORPUS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "client", "tests", "fixtures", "benign_corpus.json"), "utf8"),
);
const NOW = new Date("2026-09-29T00:00:00Z");

// ── frozen pre-B1 control code (776c3c73b tools/cursor/lib/render.ts), verbatim ──
const CTL_FENCE_RE = /=+\s*(?:END\s+)?Atlaso\s+(?:Memory|Orientation)[^\n]*/gi;
const CTL_FRONTMATTER_RE = /^---\s*$/gm;
function ctlClean(text: string): string {
  let t = (text || "").trim().replace(CTL_FENCE_RE, "[atlaso]");
  t = t.replace(CTL_FRONTMATTER_RE, "- - -");
  return t.replace(/\n/g, " ");
}

/** The bullet this connector prints for one note (last line of the recalled block). */
const bullet = (content: string) => render([{ content, scope: "personal" } as any], "", NOW).trimEnd().split("\n").pop();

describe("Cursor: benign notes are byte-identical to pre-B1", () => {
  test("corpus is non-trivial", () => expect(CORPUS.one_line.length).toBeGreaterThanOrEqual(20));
  for (const s of [...CORPUS.one_line, ...CORPUS.multi_line, ...CORPUS.mentions] as string[])
    test(JSON.stringify(s).slice(0, 60), () => expect(bullet(s)).toBe(`- ${ctlClean(s)}  [personal]`));
  test("CRLF: the only change is that the raw CR is gone", () => {
    for (const s of CORPUS.crlf as string[]) {
      expect(ctlClean(s)).toContain("\r");
      expect(bullet(s)).toBe(`- ${ctlClean(s).replaceAll("\r ", " ").replaceAll("\r", " ")}  [personal]`);
    }
  });
});
