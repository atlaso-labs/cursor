/** Outbox + drain: the durability guarantee.
 *
 *  The property under test is one sentence — a captured memory is never lost, and a
 *  poisoned item never wedges the queue behind it. Everything below is a way that
 *  property could break in production.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let TMP: string;
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "atlaso-outbox-"));
  process.env.ATLASO_GLOBAL_PATH = TMP;
});
afterEach(() => {
  delete process.env.ATLASO_GLOBAL_PATH;
  delete process.env.ATLASO_OUTBOX_MAX;
  delete process.env.ATLASO_OUTBOX_MAX_AGE_MS;
});

const TOOL = "cursor";
const item = (id: string, text = "we chose pnpm over npm") => ({
  client_id: id,
  text,
  polarity: "open",
  evidence_grade: "anecdotal",
  scope_note: null,
  tags: ["cursor", "auto"],
});

// Imported lazily inside tests so each one picks up the current env-derived paths.
async function ob() {
  return await import("../lib/outbox");
}

describe("outbox persistence", () => {
  test("enqueue then read back returns the item intact", async () => {
    const o = await ob();
    expect(o.enqueue(TOOL, item("a1"))).toBe(true);
    const p = o.pending(TOOL);
    expect(p.length).toBe(1);
    expect(p[0].client_id).toBe("a1");
    expect(p[0].item.text).toBe("we chose pnpm over npm");
    expect(p[0].attempts).toBe(0);
  });

  test("enqueue is idempotent on client_id — stop + sessionEnd write ONE record", async () => {
    const o = await ob();
    o.enqueue(TOOL, item("dup"));
    o.enqueue(TOOL, item("dup"));
    o.enqueue(TOOL, item("dup"));
    expect(o.pending(TOOL).length).toBe(1);
  });

  test("re-enqueue preserves the ORIGINAL enqueue time and attempt count", async () => {
    const o = await ob();
    o.enqueue(TOOL, item("keep"));
    const first = o.pending(TOOL)[0];
    o.bumpAttempt(TOOL, first, "boom");
    o.enqueue(TOOL, item("keep")); // same turn seen again
    const again = o.pending(TOOL)[0];
    expect(again.enqueued_at).toBe(first.enqueued_at); // age must not reset
    expect(again.attempts).toBe(1); // attempts must not reset — else never quarantines
  });

  test("settle removes the item; settling twice is harmless", async () => {
    const o = await ob();
    o.enqueue(TOOL, item("s1"));
    o.settle(TOOL, "s1");
    expect(o.pending(TOOL).length).toBe(0);
    expect(() => o.settle(TOOL, "s1")).not.toThrow();
  });

  test("pending is oldest-first so memories sync in the order they happened", async () => {
    const o = await ob();
    o.enqueue(TOOL, item("old"));
    await Bun.sleep(5);
    o.enqueue(TOOL, item("new"));
    expect(o.pending(TOOL).map((r: { client_id: string }) => r.client_id)).toEqual(["old", "new"]);
  });

  test("hasPending is false on a fresh install and true once something is queued", async () => {
    const o = await ob();
    expect(o.hasPending(TOOL)).toBe(false);
    o.enqueue(TOOL, item("h1"));
    expect(o.hasPending(TOOL)).toBe(true);
  });
});

describe("poison pills never wedge the queue", () => {
  test("an unparseable file is quarantined on sight, not re-read forever", async () => {
    const o = await ob();
    o.enqueue(TOOL, item("good"));
    writeFileSync(join(o.outboxDir(TOOL), "deadbeef.json"), "{not json", "utf8");

    const p = o.pending(TOOL);
    expect(p.map((r: { client_id: string }) => r.client_id)).toEqual(["good"]); // the good one still flows
    expect(existsSync(join(o.quarantineDir(TOOL), "deadbeef.json"))).toBe(true);
    expect(o.quarantineCount(TOOL)).toBe(1);
  });

  test("attempts are capped and the item is PARKED, never deleted", async () => {
    const o = await ob();
    o.enqueue(TOOL, item("poison"));
    let disp = "retry";
    for (let i = 0; i < o.maxAttempts() + 1 && disp === "retry"; i++) {
      const rec = o.pending(TOOL)[0];
      if (!rec) break;
      disp = o.bumpAttempt(TOOL, rec, "server 500");
    }
    expect(disp).toBe("quarantine");
    expect(o.pending(TOOL).length).toBe(0);
    expect(o._quarantinedForTests(TOOL, "poison")).toBe(true); // parked, not gone
  });

  test("quarantine writes a ledger line so a parked memory is discoverable", async () => {
    const o = await ob();
    o.enqueue(TOOL, item("q1"));
    o.quarantine(TOOL, o.pending(TOOL)[0], "server rejected: invalid");
    const led = readFileSync(o._ledgerPathForTests(TOOL), "utf8").trim();
    expect(led).toContain("server rejected: invalid");
    expect(JSON.parse(led).at).toBeTruthy();
  });
});

describe("bounds park, they never drop", () => {
  test("over-age items are quarantined rather than deleted", async () => {
    process.env.ATLASO_OUTBOX_MAX_AGE_MS = "1";
    const o = await ob();
    o.enqueue(TOOL, item("stale"));
    await Bun.sleep(5);
    const parked = o.enforceBounds(TOOL);
    expect(parked).toBe(1);
    expect(o.pending(TOOL).length).toBe(0);
    expect(o._quarantinedForTests(TOOL, "stale")).toBe(true);
  });

  test("over-capacity parks the OLDEST and keeps the newest flowing", async () => {
    process.env.ATLASO_OUTBOX_MAX = "2";
    const o = await ob();
    for (const id of ["c1", "c2", "c3"]) {
      o.enqueue(TOOL, item(id));
      await Bun.sleep(3);
    }
    o.enforceBounds(TOOL);
    const left = o.pending(TOOL).map((r: { client_id: string }) => r.client_id);
    expect(left.length).toBe(2);
    expect(left).not.toContain("c1"); // oldest parked
    expect(o._quarantinedForTests(TOOL, "c1")).toBe(true); // and recoverable
  });
});

describe("drain failure taxonomy", () => {
  const AUTH = { server: "https://brain.test", token: "t", device_id: "d" } as any;

  async function drainWith(
    resp: { ok: boolean; results?: any[]; status: number; ours?: boolean; error?: string },
    setup: (o: any) => void,
  ) {
    // Dependency injection, NOT mock.module: Bun's module mocking is process-wide
    // and would replace ../lib/atlaso for every later test file in the run
    // (it silently broke the e2e suite exactly once — hence this note).
    const deposit = (async () => ({ results: [], ours: true, ...resp })) as any;
    const o = await import("../lib/outbox");
    setup(o);
    const { drain } = await import("../lib/drain");
    return { res: await drain(TOOL, AUTH, undefined, deposit), o };
  }

  test("a 429 RETRIES and stops the pass — nothing is lost when the server sheds", async () => {
    const { res, o } = await drainWith({ ok: false, status: 429 }, (o) => o.enqueue(TOOL, item("r1")));
    expect(res.retried).toBe(1);
    expect(res.settled).toBe(0);
    expect(res.stopped).toBe(true);
    expect(o.pending(TOOL).length).toBe(1); // still queued for next time
  });

  test("a 403 from an edge/WAF RETRIES — the sync-brick incident must not repeat", async () => {
    const { res, o } = await drainWith({ ok: false, status: 403 }, (o) => o.enqueue(TOOL, item("w1")));
    expect(res.retried).toBe(1);
    expect(res.quarantined).toBe(0);
    expect(o.pending(TOOL).length).toBe(1);
  });

  test("a timeout (status 0) RETRIES", async () => {
    const { res, o } = await drainWith({ ok: false, status: 0, error: "AbortError" }, (o) =>
      o.enqueue(TOOL, item("t1")),
    );
    expect(res.retried).toBe(1);
    expect(o.pending(TOOL).length).toBe(1);
  });

  test("a 500 RETRIES and stops", async () => {
    const { res } = await drainWith({ ok: false, status: 500 }, (o) => o.enqueue(TOOL, item("e1")));
    expect(res.retried).toBe(1);
    expect(res.stopped).toBe(true);
  });

  test("a durable 4xx QUARANTINES — retrying forever would wedge the queue", async () => {
    const { res, o } = await drainWith({ ok: false, status: 400 }, (o) => o.enqueue(TOOL, item("b1")));
    expect(res.quarantined).toBe(1);
    expect(o.pending(TOOL).length).toBe(0);
    expect(o._quarantinedForTests(TOOL, "b1")).toBe(true);
  });

  test("a per-item 'added' verdict SETTLES", async () => {
    const { res, o } = await drainWith(
      { ok: true, status: 200, results: [{ client_id: "ok1", status: "added" }] },
      (o) => o.enqueue(TOOL, item("ok1")),
    );
    expect(res.settled).toBe(1);
    expect(o.pending(TOOL).length).toBe(0);
  });

  test("'duplicate' SETTLES — this is what an ambiguous timeout retry comes back as", async () => {
    const { res, o } = await drainWith(
      { ok: true, status: 200, results: [{ client_id: "d1", status: "duplicate" }] },
      (o) => o.enqueue(TOOL, item("d1")),
    );
    expect(res.settled).toBe(1);
    expect(o.pending(TOOL).length).toBe(0);
  });

  test("per-item 'invalid' QUARANTINES — the server will reject this shape forever", async () => {
    const { res, o } = await drainWith(
      { ok: true, status: 200, results: [{ client_id: "i1", status: "invalid" }] },
      (o) => o.enqueue(TOOL, item("i1")),
    );
    expect(res.quarantined).toBe(1);
    expect(o._quarantinedForTests(TOOL, "i1")).toBe(true);
  });

  test("a 2xx that omits our item RETRIES — we never assume it landed", async () => {
    const { res, o } = await drainWith(
      { ok: true, status: 200, results: [{ client_id: "somebody-else", status: "added" }] },
      (o) => o.enqueue(TOOL, item("m1")),
    );
    expect(res.retried).toBe(1);
    expect(o.pending(TOOL).length).toBe(1);
  });

  test("an empty queue is a cheap no-op", async () => {
    const { res } = await drainWith({ ok: true, status: 200 }, () => {});
    expect(res.attempted).toBe(0);
  });

  test("drain NEVER throws, even when the outbox directory is unusable", async () => {
    process.env.ATLASO_GLOBAL_PATH = "/proc/nonexistent-atlaso- bad";
    const deposit = (async () => ({ ok: true, status: 200, results: [] })) as any;
    const { drain } = await import("../lib/drain");
    const res = await drain(TOOL, AUTH, undefined, deposit);
    expect(res.attempted).toBe(0); // degraded, not crashed — the session survives
  });
});
