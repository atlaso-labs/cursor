/** Capture-counter falsifiers — lab ruling 85a5c41b: SIX green before republish.
 *  1 replay-dedup  2 burst/hour ints  3 content-free whitelist  4 emit invariant
 *  5 cross-language payload equivalence (Python golden)  6 map completeness
 *  Plus the Cursor-specific double-fire echo window.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlaso-capstats-"));
  process.env.ATLASO_GLOBAL_PATH = dir;
});
afterEach(() => {
  delete process.env.ATLASO_GLOBAL_PATH;
  rmSync(dir, { recursive: true, force: true });
});

import {
  ATTEMPT_REASONS,
  DOUBLE_FIRE_WINDOW_S,
  REASON_MAP,
  buildCaptureStats,
  markStatsSent,
  pendingCaptureStats,
  recordDepositResults,
  recordGate,
} from "../lib/capture_stats";

const at = (day: string, hour: number, plusS = 0) =>
  new Date(Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:${String(plusS).padStart(2, "0")}Z`));

// The closed server vocabulary (app.py CaptureStatsDay + drops validator).
const WHITELIST = new Set([
  "empty",
  "system_turn",
  "too_long",
  "chatter",
  "too_short",
  "duplicate",
]);

describe("6 — map completeness (closed vocabulary, ruling 85a5c41b)", () => {
  it("every non-attempt gate reason of THIS connector maps to exactly one whitelist label", () => {
    // Cursor's gate reasons (lib/capture.ts shouldDeposit) minus attempts:
    const gateReasons = ["empty", "chatter", "meta_recall", "too_short"];
    for (const r of gateReasons) {
      expect(REASON_MAP[r]).toBeDefined();
      expect(WHITELIST.has(REASON_MAP[r])).toBe(true);
    }
    // and the map NEVER invents labels outside the whitelist
    for (const v of Object.values(REASON_MAP)) expect(WHITELIST.has(v)).toBe(true);
    expect([...ATTEMPT_REASONS]).toEqual(["signal", "substantive"]);
  });
});

describe("5 — cross-language payload equivalence (Python golden fixture)", () => {
  it("the same event stream emits the Python payload byte-for-byte", async () => {
    const events: [string, string, string, number][] = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "capture_stats_events.json"), "utf8"),
    );
    for (const [kind, arg, day, hour] of events) {
      if (kind === "gate") {
        await recordGate(arg, { now: at(day, hour) });
      } else {
        await recordDepositResults([{ client_id: `${day}-${hour}-${Math.random()}`, status: arg }], {
          now: at(day, hour),
        });
      }
    }
    const golden = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "capture_stats_golden.json"), "utf8"),
    );
    const ours = buildCaptureStats();
    expect(ours).toEqual(golden); // toEqual is key-order-insensitive; day order fixed
  });
});

describe("1 — replay-dedup: duplicates never count as accepted", () => {
  it("replaying one memory reads ~0%, not 100%", async () => {
    // one turn accepted, then the same content replayed across days: server says
    // duplicate every time (distinct client keys per turn here = real replays)
    await recordGate("substantive", { now: at("2026-07-10", 9) });
    await recordDepositResults([{ client_id: "k0", status: "added" }], { now: at("2026-07-10", 9) });
    for (let d = 11; d <= 13; d++) {
      for (let i = 0; i < 4; i++) {
        await recordGate("substantive", { turnKey: `k${d}${i}`, now: at(`2026-07-${d}`, 9 + i) });
        await recordDepositResults([{ client_id: `k${d}${i}`, status: "duplicate" }], {
          now: at(`2026-07-${d}`, 9 + i),
        });
      }
    }
    const days = buildCaptureStats();
    const attempts = days.reduce((a, d) => a + d.attempts, 0);
    const accepted = days.reduce((a, d) => a + d.accepted, 0);
    const dups = days.reduce((a, d) => a + (d.drops["duplicate"] ?? 0), 0);
    expect(attempts).toBe(13);
    expect(accepted).toBe(1); // only the genuinely new memory
    expect(dups).toBe(12);
    expect(accepted / attempts).toBeLessThan(0.1);
  });
});

describe("cursor double-fire echo (stop + sessionEnd, same turn)", () => {
  it("same key within the window counts ONCE; after the window it is a real replay", async () => {
    const t0 = at("2026-07-15", 10);
    await recordGate("substantive", { turnKey: "turn-A", now: t0 });
    // sessionEnd echo 3s later — same key, inside the window
    await recordGate("substantive", { turnKey: "turn-A", now: new Date(t0.getTime() + 3000) });
    await recordDepositResults([{ client_id: "turn-A", status: "added" }], { now: t0 });
    await recordDepositResults([{ client_id: "turn-A", status: "duplicate" }], {
      now: new Date(t0.getTime() + 4000),
    });
    let d = buildCaptureStats()[0];
    expect(d.attempts).toBe(1); // echo did not double-count
    expect(d.accepted).toBe(1);
    expect(d.drops["duplicate"] ?? 0).toBe(0); // echo's duplicate skipped
    // beyond the window: same key again = a REAL replay (Python parity)
    const later = new Date(t0.getTime() + (DOUBLE_FIRE_WINDOW_S + 5) * 1000);
    await recordGate("substantive", { turnKey: "turn-A", now: later });
    await recordDepositResults([{ client_id: "turn-A", status: "duplicate" }], { now: later });
    d = buildCaptureStats()[0];
    expect(d.attempts).toBe(2);
    expect(d.drops["duplicate"]).toBe(1);
  });

  it("ADVERSE order (CodeRedTeam): duplicate lands before added — still accepted=1, duplicate=0", async () => {
    // The racing hooks' server responses process in the unfavorable order:
    // the loser's "duplicate" first, the winner's "added" second. One captured
    // turn must never read as rejected.
    const t = new Date("2026-07-15T10:00:00Z");
    await recordGate("substantive", { turnKey: "turn-A", now: t });
    await recordDepositResults([{ client_id: "turn-A", status: "duplicate" }], {
      now: new Date(t.getTime() + 3000),
    });
    await recordDepositResults([{ client_id: "turn-A", status: "added" }], {
      now: new Date(t.getTime() + 4000),
    });
    const d = buildCaptureStats()[0];
    expect(d.attempts).toBe(1);
    expect(d.accepted).toBe(1);
    expect(d.drops["duplicate"] ?? 0).toBe(0);
    // a third echo (either verdict) changes nothing
    await recordDepositResults([{ client_id: "turn-A", status: "duplicate" }], {
      now: new Date(t.getTime() + 5000),
    });
    const d2 = buildCaptureStats()[0];
    expect(d2.accepted).toBe(1);
    expect(d2.drops["duplicate"] ?? 0).toBe(0);
  });

  it("an error verdict never stamps the window (a retry's real verdict still counts)", async () => {
    const t = new Date("2026-07-16T09:00:00Z");
    await recordGate("substantive", { turnKey: "turn-B", now: t });
    await recordDepositResults([{ client_id: "turn-B", status: "error" }], {
      now: new Date(t.getTime() + 2000),
    });
    await recordDepositResults([{ client_id: "turn-B", status: "added" }], {
      now: new Date(t.getTime() + 10_000),
    });
    const d = buildCaptureStats()[0];
    expect(d.accepted).toBe(1);
  });
});

describe("2 — burst / hour-spread integers", () => {
  it("hours_active counts distinct active hours; max_hour_attempts the busiest", async () => {
    for (let i = 0; i < 9; i++) {
      await recordGate("signal", { now: at("2026-07-16", 9) }); // 9 in one hour
    }
    await recordGate("signal", { now: at("2026-07-16", 14) });
    await recordGate("substantive", { now: at("2026-07-16", 20) });
    const d = buildCaptureStats()[0];
    expect(d.attempts).toBe(11);
    expect(d.hours_active).toBe(3);
    expect(d.max_hour_attempts).toBe(9);
  });
});

describe("3 — content-free vocabulary whitelist", () => {
  it("the serialized payload contains ONLY whitelisted vocabulary — no content can leak", async () => {
    const secret = "my API key is sk-SUPER-SECRET and my dog is called Biscuit";
    await recordGate("substantive", { turnKey: "hash-of-turn", now: at("2026-07-17", 9) });
    await recordGate("chatter", { now: at("2026-07-17", 9) });
    await recordGate("meta_recall", { now: at("2026-07-17", 10) });
    await recordDepositResults([{ client_id: "hash-of-turn", status: "added" }], {
      now: at("2026-07-17", 9),
    });
    const payload = JSON.stringify(buildCaptureStats());
    for (const token of secret.split(/\s+/)) expect(payload).not.toContain(token);
    // every string in the payload is a UTC day or a fixed field/vocabulary label
    const FIXED = new Set([
      "day", "attempts", "accepted", "hours_active", "max_hour_attempts", "drops",
      ...WHITELIST,
    ]);
    const strings: string[] = [];
    JSON.parse(payload).forEach(function walk(node: unknown) {
      if (typeof node === "string") strings.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          strings.push(k);
          walk(v);
        }
      }
    });
    for (const s of strings) {
      expect(/^\d{4}-\d{2}-\d{2}$/.test(s) || FIXED.has(s)).toBe(true);
    }
  });
});

describe("4 — emit invariant: accepted ≤ attempts, always", () => {
  it("push-only days (accepted with no counted attempts) clamp at emit", async () => {
    // e.g. a manual remember settles without a gate evaluation that day
    await recordDepositResults([{ client_id: "m1", status: "added" }], { now: at("2026-07-18", 9) });
    await recordDepositResults([{ client_id: "m2", status: "added" }], { now: at("2026-07-18", 10) });
    await recordGate("substantive", { now: at("2026-07-18", 11) });
    const d = buildCaptureStats()[0];
    expect(d.attempts).toBe(1);
    expect(d.accepted).toBeLessThanOrEqual(d.attempts);
  });
});

describe("send-skip hash", () => {
  it("unchanged counters are not re-sent; new events dirty them again", async () => {
    await recordGate("signal", { now: at("2026-07-19", 9) });
    const first = pendingCaptureStats();
    expect(first).not.toBeNull();
    await markStatsSent(first!);
    expect(pendingCaptureStats()).toBeNull();
    await recordGate("signal", { now: at("2026-07-19", 10) });
    expect(pendingCaptureStats()).not.toBeNull();
  });
});
