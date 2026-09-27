// Rung 85bcf262 card B1: dated recall lines. Same cases as the Python
// atlaso_client tests/test_render_dates.py, so the three renderers agree.
import { describe, expect, test } from "bun:test";
import { dateLabel, render } from "../lib/render";

const NOW = new Date("2026-09-25T12:00:00Z");
const body = (rs: object[]) =>
  render(rs as never, "", NOW).split("\n").filter((l) => l.startsWith("- "));

describe("dated recall lines", () => {
  test("each line carries its date", () => {
    expect(body([{ content: "use bun", created_at: "2026-08-14T09:00:00+00:00" },
                 { content: "use pnpm", created_at: "2026-08-02T09:00:00+00:00" }]))
      .toEqual(["- [Aug 14] use bun", "- [Aug 2] use pnpm"]);
  });
  test("correct UTC day at day boundaries", () => {
    expect(body([{ content: "a", created_at: "2026-08-14T23:59:59.999999+00:00" },
                 { content: "b", created_at: "2026-08-15T01:30:00+05:30" },
                 { content: "c", created_at: "2026-08-14T00:00:00" }]))
      .toEqual(["- [Aug 14] a", "- [Aug 14] b", "- [Aug 14] c"]);
  });
  test("year only when older than eleven months", () => {
    expect(body([{ content: "old", created_at: "2025-09-01T00:00:00+00:00" },
                 { content: "recent", created_at: "2025-11-01T00:00:00Z" }]))
      .toEqual(["- [Sep 1 2025] old", "- [Nov 1] recent"]);
  });
  test("missing or malformed created_at renders undated", () => {
    expect(body([{ content: "a" }, { content: "b", created_at: "not-a-date" },
                 { content: "c", created_at: null }, { content: "d", created_at: "" },
                 { content: "e", created_at: 1758801600 }, { content: "f", created_at: "2026-02-30T00:00:00Z" },
                 { content: "g", created_at: "2026-08-14T24:00:00Z" }]))
      .toEqual(["- a", "- b", "- c", "- d", "- e", "- f", "- g"]);
  });
  test("month table", () => {
    expect(Array.from({ length: 12 }, (_, i) =>
      dateLabel(`2026-${String(i + 1).padStart(2, "0")}-03T00:00:00Z`, NOW)))
      .toEqual(["Jan 3", "Feb 3", "Mar 3", "Apr 3", "May 3", "Jun 3",
                "Jul 3", "Aug 3", "Sep 3", "Oct 3", "Nov 3", "Dec 3"]);
  });
  test("conflict marker and scope kept", () => {
    expect(body([{ content: "x", created_at: "2026-09-20T00:00:00", has_disagreement: true,
                   conflict_peers: ["p"], scope: "project" }]))
      .toEqual(["- [Sep 20] [conflict] x (conflicts with 1 other note)  [project]"]);
  });
  test("undated lines render first, each group in recall order (rung 85bcf262 repair)", () => {
    expect(body([{ content: "dated-1", created_at: "2026-09-01T00:00:00Z" },
                 { content: "undated-1", created_at: null },
                 { content: "dated-2", created_at: "2026-08-01T00:00:00Z" },
                 { content: "undated-2" }]))
      .toEqual(["- undated-1", "- undated-2", "- [Sep 1] dated-1", "- [Aug 1] dated-2"]);
  });
});
