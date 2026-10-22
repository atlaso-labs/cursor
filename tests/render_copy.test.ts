/** DXCritic 8565a09f item 3: no em dash in what Cursor shows. Renders the empty state, every
 *  notice and a fitted block with an omitted line, and scans the output. Fails on 21d794c11
 *  (empty state at lib/render.ts:37). The source-wide scan of every connector and the CLI is
 *  client/tests/test_no_em_dash_copy.py. */
import { expect, test } from "bun:test";
import { noticeFor, renderContext } from "../lib/render";

const V = (o: any) => ({ mode: "linked", reason: null, since: 0, checked_at: 0, active_tool: null, tool: null,
  device_id: null, grace: null, ...o });
const VERDICTS = [
  V({ mode: "local_only", reason: "not_entitled" }), V({ mode: "local_only", reason: "revoked" }),
  V({ grace: { in_grace: true, days_left: 1, tools_connected: 2 } }),
  V({ grace: { in_grace: true, days_left: 3, tools_connected: 2 } }),
  V({ grace: { in_grace: true, days_left: null, tools_connected: 2 } }),
];

test("empty state, notices and fitted blocks carry no em dash", () => {
  const outs = VERDICTS.flatMap((v) => [noticeFor(v), renderContext([], noticeFor(v))]);
  const many = Array.from({ length: 6 }, (_, i) => ({ content: `note ${i} ` + "word ".repeat(400) }));
  outs.push(renderContext(many, "", new Date(), "", 3000));
  expect(outs.some((o) => o.includes("No memories recalled yet"))).toBe(true);
  expect(outs.some((o) => o.includes("did not fit"))).toBe(true);
  for (const o of outs) expect(o).not.toContain("—");
});
