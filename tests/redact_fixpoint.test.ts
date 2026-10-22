/**
 * TIER A (CodeRedTeam 8af8fbbe CRT-1): redactLine scrubs the stored text BEFORE it tidies
 * it, and a second scrub of anything this plugin prints removes nothing (at most it
 * relabels one of the scrub's own markers: the canonical scrub flips "[REDACTED]" and
 * "[REDACTED:residue]" in URI userinfo on every pass). Mirrors Python
 * client/tests/test_redact_fixpoint.py. Synthetic strings only.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactLine, redactText, renderContext, type SpacingMode } from "../lib/render";
import { scrub } from "../lib/scrub";

const FIX = join(import.meta.dir, "..", "..", "..", "client", "tests", "fixtures");
const NOW = new Date("2026-10-22T00:00:00Z");
const MODES: SpacingMode[] = ["collapse", "join_lines", "each_line"];
const FILLER = ("Context for the synthetic staging migration: we rotated the replica, re-ran the " +
  "schema checks, confirmed the backup window, and agreed to revisit the cache eviction policy. ").repeat(3);
const UNCLOSED = 'Staging deploy settings\nDB_PASSWORD = "Zq8!vT mountain river SYNTHWORD\n' + FILLER;
const UNCLOSED_WORDS = ["Zq8!vT", "mountain", "river", "SYNTHWORD"];
const SPLIT_LABEL = "secret:\r\n'copper meadow\nnext line stays\r\n" + FILLER;
const SPLIT_WORDS = ["copper", "meadow"];
const SEPS = ["\n", "\r\n", " ", "\x0b", "\x0c"];
const block = (results: any[]) => renderContext(results, "", NOW, "", 1 << 20);

const base: string[] = [
  ...JSON.parse(readFileSync(join(FIX, "redact_contract.json"), "utf8")).cases.map((c: any) => c.input),
  ...JSON.parse(readFileSync(join(FIX, "scrub_parity.json"), "utf8")).cases.map((c: any) => c.text),
];
const CORPUS: string[] = [UNCLOSED, SPLIT_LABEL];
base.forEach((s, i) => {
  const w = SEPS[i % SEPS.length]!;
  const q = Math.max(s.lastIndexOf('"'), s.lastIndexOf("'"));
  CORPUS.push(s, s.replace(" ", w) + w + FILLER, (q > 0 ? s.slice(0, q) + s.slice(q + 1) : s) + w + FILLER);
});
const unlabel = (s: string) => s.replace(/\[REDACTED(?::[a-z0-9_]+)?\]/gu, "[REDACTED]");
const fixed = (out: string) => {
  const [again] = scrub(out);
  return again === out || unlabel(again) === unlabel(out);
};

describe("CRT-1: the unclosed-quote value is masked whole", () => {
  for (const m of MODES)
    test(`redactLine [${m}]`, () => {
      for (const [text, words] of [[UNCLOSED, UNCLOSED_WORDS], [SPLIT_LABEL, SPLIT_WORDS]] as const) {
        const line = redactLine(text, m);
        expect(line).toContain("[REDACTED]");
        expect(words.filter((w) => line.includes(w))).toEqual([]);
      }
    });
  test("hook block, content and short form", () => {
    const b = block([{ content: UNCLOSED, short: UNCLOSED.slice(0, 60), scope: "personal" },
      { content: SPLIT_LABEL, scope: "personal" }, { content: FILLER + FILLER, short: UNCLOSED.slice(0, 80) }]);
    expect(b).toContain("[REDACTED]");
    expect([...UNCLOSED_WORDS, ...SPLIT_WORDS].filter((w) => b.includes(w))).toEqual([]);
  });
  test("clean text keeps its bytes; unknown mode still throws", () => {
    for (const m of MODES) expect(redactLine("use pnpm, never npm in CI", m)).toBe("use pnpm, never npm in CI");
    expect(() => redactLine("", "bogus" as SpacingMode)).toThrow();
  });
});

describe("a second scrub removes nothing", () => {
  test("corpus is non-trivial", () => expect(CORPUS.length).toBeGreaterThan(300));
  for (const m of MODES)
    test(`redactLine [${m}]`, () => expect(CORPUS.filter((s) => !fixed(redactLine(s, m)))).toEqual([]));
  test("redactText (MCP recall/recent)", () =>
    expect(CORPUS.filter((s) => !fixed(redactText(s) as string))).toEqual([]));
  test("every hook-block line (scope suffix left out: metadata, not note text)", () => {
    const bad: string[] = [];
    for (let i = 0; i < CORPUS.length; i += 4) {
      const b = block(CORPUS.slice(i, i + 4).map((s) => ({ content: s, short: s.slice(0, 48) })));
      bad.push(...b.split("\n").filter((ln) => !fixed(ln)));
    }
    expect(bad).toEqual([]);
  });
  test("the tolerance is only a marker label", () => {
    const once = redactText("db at postgres://syn:SyntheticPw9dfe@db.example.invalid/app") as string;
    expect(once).not.toContain("SyntheticPw9dfe");
    expect(fixed(once)).toBe(true);
    expect(fixed(once.replace("[REDACTED]", "SyntheticPw9dfe"))).toBe(false);
  });
});
