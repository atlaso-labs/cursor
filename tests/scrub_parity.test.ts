/**
 * TIER A (CodeRedTeam c2d2ddcc F1): this plugin's credential scrub knows what the server
 * scrubber knows. `scrubCore` must reproduce the server's recorded output on every case of
 * the shared fixture (client/tests/fixtures/scrub_parity.json, regenerated from the server
 * by make_scrub_parity.py), and `scrub` (what capture and render use) the connector's.
 * server/test_scrub_connector_parity.py also runs this port live against the server over
 * a 4,000-string fuzz. On 03a5e0322 the capture scrub missed 7 of CodeRedTeam's 8 shapes,
 * and the renderers passed them to the model verbatim. Same file in tools/cursor and
 * tools/opencode. Synthetic strings only.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scrub as captureScrub } from "../lib/capture";
import { redactLine, redactText } from "../lib/render";
import { scrub, scrubCore } from "../lib/scrub";

const FIXTURE = join(import.meta.dir, "..", "..", "..", "client", "tests", "fixtures", "scrub_parity.json");
type Case = { name: string; text: string; server: [string, string[]]; connector: [string, string[]] };
const cases: Case[] = JSON.parse(readFileSync(FIXTURE, "utf8")).cases;
const NOW = new Date("2026-10-22T00:00:00Z");

describe("scrub port matches the server scrubber on the shared fixture", () => {
  test("fixture is non-trivial", () => expect(cases.length).toBeGreaterThanOrEqual(60));
  for (const c of cases) {
    test(`core ${c.name}`, () => expect(scrubCore(c.text)).toEqual(c.server));
    test(`connector ${c.name}`, () => expect(scrub(c.text)).toEqual(c.connector));
  }
  test("capture uses the same scrub", () => expect(captureScrub).toBe(scrub));
  test("a clean note is returned as the same string, NFD kept", () => {
    const t = "café notes stay as typed";
    expect(scrub(t)).toEqual([t, []]);
    expect(redactText(t)).toBe(t);
  });
});

// CodeRedTeam c2d2ddcc's eight probe strings, unchanged, with the raw piece to look for.
const SHAPES: Record<string, [string, string]> = {
  stripe_short: ["Billing uses sk_live_SYNTHab12CD34ef56GH78 for the staging account.", "SYNTHab12"],
  whsec: ["Webhook signing secret whsec_SYNTHab12CD34ef56GH78ij for staging.", "SYNTHab12"],
  glpat: ["CI pushes with glpat-SYNTHab12CD34ef56 on the runner.", "SYNTHab12"],
  prose_pw: ["The staging db password is Tr0ub4dor-SYNTH-77 for the admin user.", "Tr0ub4dor"],
  pin: ["Enter the PIN 4471 at the synthetic side door.", "4471"],
  hex48: ["deploy key 0123456789abcdef0123456789abcdef0123456789abcdef used by CI", "0123456789abcdef0123"],
  value_first: ["'Hunter2-SYNTH' is the root password on the test box.", "Hunter2"],
  sk_hyphen: ["Use sk-SYNTHabcdefghijklmnop1234 for the test.", "SYNTHabcdefgh"],
};

describe("c2d2ddcc shapes never reach the model", async () => {
  const r: any = await import("../lib/render");
  const block = (results: any[]): string =>
    r.renderContext ? r.renderContext(results, "", NOW, "") : (r.renderBlock(results, { now: NOW }) ?? "");
  for (const [name, [text, secret]] of Object.entries(SHAPES)) {
    test(name, () => {
      expect(redactLine(text)).not.toContain(secret);
      expect(redactLine(text)).toContain("[REDACTED");
      expect(String(redactText(text))).not.toContain(secret);
      const out = block([{ id: "n1", content: text, created_at: "2026-10-01T00:00:00Z" }]);
      expect(out).toContain("[REDACTED");
      expect(out).not.toContain(secret);
      expect(out).toContain(text.split(" ").pop()!); // redacted in place, not dropped
    });
  }
});
