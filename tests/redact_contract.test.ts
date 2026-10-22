/**
 * TIER A (SecurityEngineer 4c26fd7d finding 2): no stored credential reaches the injected
 * block. redactLine must match the Python contract (atlaso_client._render.redact_line) on
 * the shared fixture, and the real renderer must redact note text and short forms in place
 * (never drop the note) and fit the budget on the redacted bytes. Fails on 21d794c11
 * (no redactLine; verbatim note text). Synthetic credentials only.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactLine, renderContext, type SpacingMode } from "../lib/render";

const FIXTURE = join(import.meta.dir, "..", "..", "..", "client", "tests", "fixtures", "redact_contract.json");
type Case = { name: string; input: string; expected: Record<SpacingMode, string> };
const cases: Case[] = JSON.parse(readFileSync(FIXTURE, "utf8")).cases;
const NOW = new Date("2026-10-22T00:00:00Z");
const block = (results: any[], max?: number) => renderContext(results, "", NOW, "", max);

describe("redactLine matches the shared contract fixture", () => {
  test("fixture is non-trivial", () => expect(cases.length).toBeGreaterThanOrEqual(15));
  for (const c of cases)
    for (const m of Object.keys(c.expected) as SpacingMode[])
      test(`${c.name} [${m}]`, () => expect(redactLine(c.input, m)).toBe(c.expected[m]));
});

const PAD = "deployment migration schema cache index runner ";
const SENTINELS = ["sk-SYNTHETICcanary0000dfe1ca8e", "ghp_SYNTHETICcanary000000dfe1ca8e00", "AKIASYNTHETIC0DFE1CA",
  "sk_test_SYNTHETIC_SECRET_CANARY_4c26fd7d_ONLY", "SyntheticPw_dfe1ca8e"];
const carrier = (s: string) => (s.startsWith("Synthetic") ? `password=${s}` : s);
function positions(secret: string): Record<string, string> {
  const tok = carrier(secret);
  const long = PAD.repeat(62);
  const cut = 600 - Math.floor(tok.length / 2) - 1; // the token straddles character 600
  return {
    start: `${tok} ${long}`,
    middle: `${long.slice(0, 1500)} ${tok} ${long.slice(1500)}`,
    end: `${long} ${tok}`,
    window_boundary: `${long.slice(0, cut)} ${tok} ${long.slice(cut)}`,
  };
}

describe("the rendered block never carries a stored credential", () => {
  for (const secret of SENTINELS)
    for (const [where, text] of Object.entries(positions(secret)))
      test(`${where}: ${secret.slice(0, 8)}`, () => {
        if (where === "window_boundary") {
          const at = text.indexOf(carrier(secret));
          expect(at < 600 && 600 < at + carrier(secret).length).toBe(true);
        }
        const b = block([{ content: text, created_at: "2026-10-20T00:00:00Z" }]);
        expect(b).not.toContain(secret);
        expect(b).toContain("REDACTED");
        expect(b.split("\n- ").length - 1).toBe(1); // kept, redacted in place
      });

  for (const secret of SENTINELS)
    test(`short form: ${secret.slice(0, 8)}`, () => {
      const b = block([{ content: positions(secret).middle, short: `Rotate ${carrier(secret)} before release.` }], 600);
      expect(b).not.toContain(secret);
      expect(b).toContain("Rotate");
      expect(b).toContain("REDACTED");
    });

  test("SecurityEngineer 4c26fd7d probe note, injection half", () => {
    const cred = "sk_test_SYNTHETIC_SECRET_CANARY_4c26fd7d_ONLY";
    const text = `Gateway credential is ${cred}. Rotate it before release. ` + PAD.repeat(50);
    const b = block([{ content: text, short: `Gateway credential is ${cred}. Rotate it before release.` }], 400);
    expect({ injection: b.includes(cred) }).toEqual({ injection: false });
    expect(b).toContain("Rotate it before release.");
  });

  test("the budget measures the redacted text", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\n" + "SYNTHETICdfe1ca8e".repeat(400) + "\n-----END RSA PRIVATE KEY-----";
    const b = block([{ content: `deploy key for the synthetic runner: ${key} (rotate monthly)` }], 2000);
    expect(b).not.toContain("SYNTHETICdfe1ca8e");
    expect(b).toContain("deploy key for the synthetic runner: [REDACTED:private_key] (rotate monthly)");
    expect(b).not.toContain("did not fit");
  });
});
