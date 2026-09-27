/** Render the recalled-memory rules file delivered at sessionStart.
 *
 * WHY a rules file: Cursor's `sessionStart` `additional_context` injection is
 * broken in 3.x (staff-acknowledged timing bug). Cursor's RULES engine reliably
 * injects `alwaysApply` rules, so we write the recalled notes into
 * `<workspace>/.cursor/rules/atlaso-recall.mdc` — a working channel. The file is
 * rewritten each session and safe to .gitignore.
 *
 * Per-note semantics mirror the Python `_render.recall_block`: a plain branded
 * block (no "untrusted data" warning, no instructions — the model decides); each
 * conflict is flagged with a peer COUNT (never leaking internal ids); scope is
 * appended. Stored content is sanitized so it can't forge mdc frontmatter or our
 * fence.
 */
import { join } from "node:path";
import type { RecallResult } from "./atlaso";
import { LOCAL_ONLY, NOT_ENTITLED, REVOKED, type Verdict } from "./state";

const APP = "https://app.atlaso.ai";

const BANNER = "Atlaso Memory";
const FENCE_RE = /=+\s*(?:END\s+)?Atlaso\s+(?:Memory|Orientation)[^\n]*/gi;
const FRONTMATTER_RE = /^---\s*$/gm;

const HEADER =
  "---\n" +
  "description: Atlaso long-term memory recalled for this session\n" +
  "alwaysApply: true\n" +
  "---\n\n" +
  `# ${BANNER}\n\n` +
  "Recalled notes from prior sessions, about the user and this project.\n\n";

const EMPTY_BODY = "_No memories recalled yet — they'll appear here as you work._\n";

function clean(text: string): string {
  let t = (text || "").trim().replace(FENCE_RE, "[atlaso]");
  // never let stored content open/close mdc frontmatter
  t = t.replace(FRONTMATTER_RE, "- - -");
  return t.replace(/\n/g, " ");
}

// Rung 85bcf262 (card B1): each line carries its note's UTC calendar day, mirroring the
// Python `_render._date_label` ("Aug 14"; "Aug 14 2025" when more than
// 335 days older than now) for every string the server sends (isoformat(), UTC).
// Missing/malformed created_at (an older brain) = no date.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEAR_AFTER_DAYS = 335;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?(Z|[+-]\d{2}:\d{2})?$/;

export function dateLabel(createdAt: unknown, now: Date = new Date()): string | null {
  if (typeof createdAt !== "string" || !ISO_RE.test(createdAt)) return null;
  // Reject impossible calendar/clock fields (Feb 30, 24:00) that Date.parse rolls over
  // but Python's fromisoformat refuses, so both renderers leave the line undated.
  const [y, mo, d, h = 0, mi = 0, s = 0] = createdAt.match(/\d+/g)!.slice(0, 6).map(Number);
  const cal = new Date(Date.UTC(y!, mo! - 1, d!));
  if (cal.getUTCMonth() !== mo! - 1 || cal.getUTCDate() !== d! || h > 23 || mi > 59 || s > 59) return null;
  // No offset = UTC (JS would otherwise read a date-time without one as LOCAL time).
  const hasTime = createdAt.length > 10;
  const iso = /(Z|[+-]\d{2}:\d{2})$/.test(createdAt) ? createdAt
    : hasTime ? createdAt + "Z" : createdAt + "T00:00:00Z";
  const ms = Date.parse(iso.replace(" ", "T"));
  if (Number.isNaN(ms)) return null;
  const dt = new Date(ms);
  let label = `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
  if (Math.floor((now.getTime() - ms) / 86_400_000) > YEAR_AFTER_DAYS) label += ` ${dt.getUTCFullYear()}`;
  return label;
}

/** Stable partition: UNDATED lines first, then dated lines, each in recall order
 *  (mirrors Python `_render.undated_first`). A null created_at means the server
 *  could not justify an original statement time, so that line is never placed
 *  where a reader would take it for the newest note. */
export function undatedFirst(lines: Array<[boolean, string]>): string[] {
  return [...lines.filter(([d]) => !d), ...lines.filter(([d]) => d)].map(([, l]) => l);
}

/** One bullet per result, with conflict flag + peer count + scope (mirrors the
 *  Python recall_block). */
function line(r: RecallResult, now: Date): [boolean, string] | null {
  const content = clean(r.content || "");
  if (!content) return null;
  const hd = !!r.has_disagreement;
  const date = dateLabel(r.created_at, now);
  let out = "- " + (date ? `[${date}] ` : "") + (hd ? "[conflict] " : "") + content;
  const peers = Array.isArray(r.conflict_peers) ? r.conflict_peers.length : 0;
  if (hd && peers) out += ` (conflicts with ${peers} other note${peers !== 1 ? "s" : ""})`;
  if (r.scope) out += `  [${r.scope}]`;
  return [date !== null, out];
}

/** A user-facing notice for the rules file (Cursor has no terminal banner, so the
 *  rules file the model reads is the only channel). Empty unless local-only/grace.
 *  Ported from the Python connectors' notice messages. */
export function noticeFor(mode: Verdict): string {
  const g = mode.grace;
  if (g && g.in_grace) {
    const d = g.days_left;
    const when = d != null && d <= 1 ? "Last day" : d != null ? `${d} days left` : "A few days left";
    return `> **Atlaso** · your Pro plan ended — Free keeps 1 tool. ${when} to upgrade at ${APP} and keep them all, or we'll keep your most-recently-used tool. Your memory stays safe.\n\n`;
  }
  if (mode.mode === LOCAL_ONLY) {
    if (mode.reason === NOT_ENTITLED)
      return `> **Atlaso** · Cursor isn't your active tool on the free plan — running local-only, so memory isn't syncing here. Switch tools or upgrade at ${APP} to use Atlaso memory in Cursor.\n\n`;
    if (mode.reason === REVOKED)
      return `> **Atlaso** · this device was disconnected — local-only. Reconnect at ${APP} to resume sync.\n\n`;
  }
  return "";
}

/** Build the .mdc body (optional user notice + recalled notes). An empty result
 *  yields a harmless placeholder, so the file is always valid. */
export function render(results: RecallResult[], notice = "", now: Date = new Date()): string {
  const pairs: Array<[boolean, string]> = [];
  for (const r of results || []) {
    const l = line(r, now);
    if (l) pairs.push(l);
  }
  const lines = undatedFirst(pairs);
  const body = lines.length ? lines.join("\n") + "\n" : EMPTY_BODY;
  return HEADER + (notice || "") + body;
}

export function rulesPath(workspace: string): string {
  return join(workspace, ".cursor", "rules", "atlaso-recall.mdc");
}
