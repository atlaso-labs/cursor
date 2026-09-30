/**
 * Security batch B1 (G1 + the Unicode/marker low): this connector's sanitizeLine must
 * give byte-identical results to the Python contract (atlaso_client._render
 * .sanitize_line) on the shared fixture, in every spacing mode, and keep every note on
 * one line.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeLine, type SpacingMode } from "../lib/render";

const FIXTURE = join(import.meta.dir, "..", "..", "..", "client", "tests", "fixtures", "sanitize_contract.json");
type Case = { name: string; input: string; expected: string | Record<SpacingMode, string> };
const cases: Case[] = JSON.parse(readFileSync(FIXTURE, "utf8")).cases;
const MODES: SpacingMode[] = ["collapse", "join_lines", "each_line"];
const expected = (c: Case, m: SpacingMode) => (typeof c.expected === "string" ? c.expected : c.expected[m]);

describe("sanitizeLine matches the shared contract fixture", () => {
  test("fixture is non-trivial", () => expect(cases.length).toBeGreaterThanOrEqual(30));
  for (const c of cases)
    for (const m of MODES) test(`${c.name} [${m}]`, () => expect(sanitizeLine(c.input, m)).toBe(expected(c, m)));
});

describe("sanitizeLine invariants", () => {
  test("no line terminator, no control but tab, no surrogate, Cf only as an allowed joiner", () => {
    let all = "";
    for (let cp = 0; cp <= 0x3000; cp++) all += String.fromCodePoint(cp) + "x";
    all += "\u{e0041}\u{e007f}\ufeff\ud800";
    for (const m of MODES) {
      const out = sanitizeLine(all, m);
      expect(out.split(/\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/).length).toBe(1);
      const cps = Array.from(out);
      const bad = cps.filter((c, i) =>
        c !== "\t" && /^[\p{Cc}\p{Cf}\p{Cs}]$/u.test(c) &&
        !((c === "\u200c" || c === "\u200d") && cps[i - 1]! >= "\u0080" && cps[i + 1]! >= "\u0080"));
      expect(bad).toEqual([]);
    }
    expect(sanitizeLine("a\u200d\u{1F469}\u200d\u{1F4BB}\u200db\u200c\u0645\u200c\u06cc")).toBe(
      "a\u{1F469}\u200d\u{1F4BB}b\u0645\u200c\u06cc",
    );
  });
  test("non-strings render empty; an unknown mode throws", () => {
    expect(sanitizeLine(undefined)).toBe("");
    expect(sanitizeLine(42)).toBe("");
    expect(() => sanitizeLine("x", "keep_everything" as SpacingMode)).toThrow();
  });
  test("linear on long hostile input", () => {
    for (const m of MODES) {
      const t0 = performance.now();
      sanitizeLine(
        "atlaso memory ".repeat(10000) + "=".repeat(200000) + "\uff21".repeat(50000) +
          "== atlaso memory ==\t".repeat(5000) + " \n".repeat(50000),
        m,
      );
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });
});
