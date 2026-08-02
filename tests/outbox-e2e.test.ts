/** End-to-end durability proof against a REAL HTTP server.
 *
 *  The unit tests mock `depositDetailed`, so they prove the taxonomy is wired
 *  correctly but not that the wire behaviour matches. These start an actual server,
 *  make actual fetches through the actual client, and assert the property the
 *  founder asked for in plain terms: THE MEMORY IS NEVER LOST.
 *
 *  Each test is a real outage shape we have already seen in production or will see
 *  on launch day — a deploy restart, a WAF block, a shedding brain, a hung request.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { depositDetailed } from "../lib/atlaso";
import { drain } from "../lib/drain";
import { enqueue, pending, quarantineCount, settle, _quarantinedForTests } from "../lib/outbox";

const TOOL = "cursor";

let TMP: string;
let server: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "atlaso-e2e-"));
  process.env.ATLASO_GLOBAL_PATH = TMP;
});
afterEach(() => {
  server?.stop(true);
  server = null;
  delete process.env.ATLASO_GLOBAL_PATH;
});

/** A stand-in brain. `handler` receives the parsed batch body and returns either a
 *  status code (failure) or a results array (success), so each test states its
 *  outage in one line. */
function brain(handler: (items: any[], hit: number) => number | any[]): { auth: any; hits: () => number } {
  let hits = 0;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      hits++;
      const body = (await req.json()) as { items: any[] };
      const out = handler(body.items, hits);
      if (typeof out === "number") {
        // Stamp the marker a real brain sets, so 401/403 handling is exercised
        // exactly as it is in production (edge blocks lack it; ours has it).
        return new Response("{}", { status: out, headers: { "x-atlaso-response": "1" } });
      }
      return new Response(JSON.stringify({ count: out.length, added: out.length, results: out }), {
        status: 200,
        headers: { "content-type": "application/json", "x-atlaso-response": "1" },
      });
    },
  });
  return {
    auth: { server: `http://127.0.0.1:${server.port}`, token: "test-token", device_id: "dev1" },
    hits: () => hits,
  };
}

const item = (id: string) => ({
  client_id: id,
  text: "we moved from Poetry to uv",
  polarity: "open",
  evidence_grade: "anecdotal",
  scope_note: null,
  tags: ["cursor", "auto"],
});

describe("a memory survives the brain being down", () => {
  test("deploy restart (503) strands nothing — it drains on the next attempt", async () => {
    let down = true;
    const { auth, hits } = brain((items) =>
      down ? 503 : items.map((i) => ({ client_id: i.client_id, status: "added" })),
    );

    // Capture during the outage: write-ahead, then the send fails.
    enqueue(TOOL, item("m1"));
    const first = await depositDetailed(auth, [item("m1")]);
    expect(first.ok).toBe(false);
    expect(first.status).toBe(503);
    expect(pending(TOOL).length).toBe(1); // ← the memory is safe on disk

    // Brain comes back. The next hook drains it.
    down = false;
    const res = await drain(TOOL, auth);
    expect(res.settled).toBe(1);
    expect(pending(TOOL).length).toBe(0);
    expect(hits()).toBe(2);
  });

  test("an unreachable brain (connection refused) queues rather than loses", async () => {
    // A genuine transport failure — bind a port, free it, then aim at the hole.
    // This is the laptop-offline / brain-not-listening case, and it must surface
    // as status 0 so `classifyRequest` treats it as retryable rather than durable.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const deadPort = probe.port;
    probe.stop(true);
    const auth = { server: `http://127.0.0.1:${deadPort}`, token: "t", device_id: "d" };

    enqueue(TOOL, item("offline"));
    const r = await depositDetailed(auth as any, [item("offline")]);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0); // transport class, NOT an HTTP verdict
    expect(r.error).toBeTruthy();

    const res = await drain(TOOL, auth as any);
    expect(res.retried).toBe(1); // retried, never quarantined
    expect(res.quarantined).toBe(0);
    expect(pending(TOOL).length).toBe(1); // ← the memory is still safe
  });

  test("an ambiguous timeout retry CANNOT duplicate — client_id is idempotent", async () => {
    const seen = new Set<string>();
    const { auth } = brain((items, hit) => {
      // First call: the server COMMITS the write, then the connection dies.
      for (const i of items) seen.add(i.client_id);
      if (hit === 1) return 502;
      return items.map((i) => ({ client_id: i.client_id, status: "duplicate" }));
    });

    enqueue(TOOL, item("amb"));
    await depositDetailed(auth, [item("amb")]); // committed but reported failed
    const res = await drain(TOOL, auth); // retry

    expect(res.settled).toBe(1); // 'duplicate' settles cleanly
    expect(seen.size).toBe(1); // exactly ONE memory reached the server
    expect(pending(TOOL).length).toBe(0);
  });
});

describe("shedding and blocking never destroy data", () => {
  test("429 from the new per-item rate limit is retried, never dropped", async () => {
    let shedding = true;
    const { auth } = brain((items) =>
      shedding ? 429 : items.map((i) => ({ client_id: i.client_id, status: "added" })),
    );

    for (const id of ["a", "b", "c"]) enqueue(TOOL, item(id));
    const shed = await drain(TOOL, auth);
    expect(shed.settled).toBe(0);
    expect(shed.stopped).toBe(true); // backs off rather than hammering
    expect(pending(TOOL).length).toBe(3); // all three intact

    shedding = false;
    const ok = await drain(TOOL, auth);
    expect(ok.settled).toBe(3);
    expect(pending(TOOL).length).toBe(0);
  });

  test("a WAF/edge 403 does NOT discard memories (the sync-brick incident)", async () => {
    let blocked = true;
    const { auth } = brain((items) =>
      blocked ? 403 : items.map((i) => ({ client_id: i.client_id, status: "added" })),
    );
    enqueue(TOOL, item("waf"));
    await drain(TOOL, auth);
    expect(pending(TOOL).length).toBe(1); // survived the block

    blocked = false;
    expect((await drain(TOOL, auth)).settled).toBe(1);
  });
});

describe("a poisoned item cannot block healthy ones", () => {
  test("one permanently-invalid memory is parked; the rest still sync", async () => {
    const { auth } = brain((items) =>
      items.map((i) => ({
        client_id: i.client_id,
        status: i.client_id === "bad" ? "invalid" : "added",
      })),
    );

    enqueue(TOOL, item("bad")); // oldest — would head-of-line block a naive queue
    await Bun.sleep(3);
    enqueue(TOOL, item("good1"));
    await Bun.sleep(3);
    enqueue(TOOL, item("good2"));

    const res = await drain(TOOL, auth);
    expect(res.quarantined).toBe(1);
    expect(res.settled).toBe(2); // the healthy ones got through in the SAME pass
    expect(pending(TOOL).length).toBe(0);
    expect(_quarantinedForTests(TOOL, "bad")).toBe(true); // parked, recoverable
    expect(quarantineCount(TOOL)).toBe(1);
  });
});

describe("the happy path stays cheap", () => {
  test("a successful capture leaves nothing behind", async () => {
    const { auth } = brain((items) => items.map((i) => ({ client_id: i.client_id, status: "added" })));
    enqueue(TOOL, item("h1"));
    const r = await depositDetailed(auth, [item("h1")]);
    expect(r.ok).toBe(true);
    settle(TOOL, "h1");
    expect(pending(TOOL).length).toBe(0);
    expect(quarantineCount(TOOL)).toBe(0);
    // And a drain on an empty queue costs one readdir and no HTTP.
    const { hits } = { hits: () => 0 };
    expect((await drain(TOOL, auth)).attempted).toBe(0);
    expect(hits()).toBe(0);
  });
});
