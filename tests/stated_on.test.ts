import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { statedOn } from "../lib/mcp";

// One memory skill, item 5: the same golden vectors as atlaso_mcp.tools.stated_on
// and the hosted MCP (server/mcp_app.py). null = unknown, never a manufactured date.
const VECTORS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "mcp", "tests", "stated_on_vectors.json"), "utf8"),
).vectors as Array<[unknown, string | null]>;

describe("statedOn", () => {
  test("vectors file is present and non-trivial", () => {
    expect(VECTORS.length).toBeGreaterThan(10);
  });
  for (const [value, want] of VECTORS) {
    test(`${JSON.stringify(value)} -> ${JSON.stringify(want)}`, () => {
      expect(statedOn(value)).toBe(want);
    });
  }
});

