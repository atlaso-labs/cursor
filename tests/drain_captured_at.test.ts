// Rung 85bcf262 repair: a queued (delayed) push carries its capture time, the
// outbox enqueue time, as captured_at, so the brain dates it by capture.
import { describe, expect, test } from "bun:test";
import { timedItem } from "../lib/drain";

const item = { client_id: "c1", text: "synthetic note", polarity: "open",
  evidence_grade: "anecdotal", scope_note: null, tags: [] };

describe("timedItem", () => {
  test("stamps the enqueue time as ISO-8601 UTC", () => {
    const at = Date.UTC(2026, 8, 1, 8, 0, 0);
    expect(timedItem({ client_id: "c1", item, enqueued_at: at, attempts: 0 }))
      .toEqual({ ...item, captured_at: "2026-09-01T08:00:00.000Z" });
  });
  test("leaves the item unstamped when the enqueue time is unusable", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "x" as never]) {
      expect(timedItem({ client_id: "c1", item, enqueued_at: bad, attempts: 0 })).toEqual(item);
    }
  });
});
