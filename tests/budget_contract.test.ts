// Injection budget (plugin/hook-budget): the shared fitter contract
// (client/tests/fixtures/budget_contract.json, produced by atlaso_client._inject) and the
// rendered block's size for long, multibyte and pasted-code notes. Synthetic only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fitLines, omittedLine, renderContext, utf8Bytes, INJECT_BUDGET_BYTES } from "../lib/render";

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../client/tests/fixtures/budget_contract.json"), "utf8"),
);
const NOW = new Date("2026-10-22T00:00:00Z");
const render = (rs: any[]) => renderContext(rs, "", NOW);
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("budget contract (shared with pytest)", () => {
  test("constants match the Python fitter", () => {
    expect(INJECT_BUDGET_BYTES).toBe(FIXTURE.budget);
    expect(omittedLine(3)).toBe(FIXTURE.omitted_line_3);
    expect(omittedLine(1)).toBe(FIXTURE.omitted_line_1);
  });
  test("every case reproduces the Python decisions exactly", () => {
    for (const c of FIXTURE.cases) {
      expect(fitLines(c.head, c.tail, c.cands, c.budget)).toEqual(c.expect);
    }
  });
  test("utf8Bytes counts UTF-8 bytes", () => {
    expect(utf8Bytes("a記🧪é")).toBe(1 + 3 + 4 + 2);
  });
});

const transcript = (i: number, n: number) =>
  (`note ${i} user words about the synthetic gateway `.repeat(n / 40) + " (assistant: " + "reply words ".repeat(n / 12)).slice(0, n - 1) + ")";
const KINDS: Record<string, (i: number) => string> = {
  median: (i) => transcript(i, 2818),
  p90: (i) => transcript(i, 4143),
  cjk: (i) => `${i} ` + "記憶網関決定単一利用者".repeat(180),
  emoji: (i) => `${i} ` + "🧪🚀a".repeat(700),
  long_line: (i) => `${i}` + "x".repeat(20000),
  code: (i) => `# ${i}\n` + "def f(x):\n\treturn {'k': x}  # pasted\n".repeat(120),
};

describe("rendered block stays under the budget", () => {
  for (const [kind, make] of Object.entries(KINDS)) {
    test(`five ${kind} notes: under budget, top note whole`, () => {
      const results = [0, 1, 2, 3, 4].map((i) => ({ content: make(i), scope: "project", created_at: "2026-10-02T09:00:00Z" }));
      const out = render(results);
      expect(bytes(out)).toBeLessThanOrEqual(9000);
      if (kind !== "long_line") {
        const flat = (s: string) => s.split(/\s+/).join(" ");
        const first = Array.from(flat(results[0].content));
        expect(flat(out)).toContain(first.slice(0, 200).join(""));
        expect(flat(out)).toContain(first.slice(-200).join(""));
      } else {
        expect(out).not.toContain("xxxx");
      }
    });
  }
  test("repeated identical input renders identically", () => {
    const results = [0, 1, 2, 3, 4].map((i) => ({ content: transcript(i, 4143) }));
    expect(render(results)).toBe(render(results));
  });
});

describe("renderContext frame", () => {
  test("a budget too small for any note keeps the notice and hint, never over", () => {
    const out = renderContext([{ content: "x".repeat(50) }], "> notice\n\n", NOW, "> hint", 120);
    expect(bytes(out)).toBeLessThanOrEqual(120);
    expect(out).toContain("> notice");
    expect(out).toContain("> hint");
    expect(out).not.toContain("xxxx");
  });
});

describe("off switch (memo item 32 rollback)", () => {
  test("ATLASO_INJECT_BUDGET=off prints every note with no closing line", () => {
    const rs = [0, 1, 2, 3, 4].map((i) => ({ content: transcript(i, 4143) }));
    const prev = process.env.ATLASO_INJECT_BUDGET;
    process.env.ATLASO_INJECT_BUDGET = "off";
    try {
      const out = renderContext(rs as any, "", NOW);
      expect(out.split("\n").filter((l) => l.startsWith("- ")).length).toBe(5);
      expect(out).not.toContain("did not fit");
    } finally {
      if (prev === undefined) delete process.env.ATLASO_INJECT_BUDGET;
      else process.env.ATLASO_INJECT_BUDGET = prev;
    }
    expect(bytes(renderContext(rs as any, "", NOW))).toBeLessThanOrEqual(9000);
  });
});
