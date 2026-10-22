/** Render the recalled-memory block delivered at sessionStart.
 *
 * WHERE it goes (security batch B1, round 3): the block reaches the session only as the
 * sessionStart hook's `additional_context` (renderContext). Nothing is written into the
 * workspace: a recall file under `.cursor/rules` could be committed after the folder is
 * copied into a new repository, and a Git-ignored rules file may not be loaded by the
 * Cursor IDE at all. When Cursor drops `additional_context` (a staff-acknowledged timing bug
 * in the IDE), the plugin's shipped rule tells the agent to call the Atlaso `recall` tool.
 * `render` keeps the historical rules-file bytes (frontmatter + block) as the parity
 * reference for the shared line contract.
 *
 * Per-note semantics mirror the Python `_render.recall_block`: a plain branded
 * block (no "untrusted data" warning, no instructions — the model decides); each
 * conflict is flagged with a peer COUNT (never leaking internal ids); scope is
 * appended. Every stored string passes sanitizeLine (below, Cursor's "each_line" spacing),
 * so it stays on its own bullet line: it can't open mdc frontmatter or forge our fence.
 */
import type { RecallResult } from "./atlaso";
import { LOCAL_ONLY, NOT_ENTITLED, REVOKED, type Verdict } from "./state";
import { scrub } from "./capture";

const APP = "https://app.atlaso.ai";

const BANNER = "Atlaso Memory";

const FRONTMATTER =
  "---\n" +
  "description: Atlaso long-term memory recalled for this session\n" +
  "alwaysApply: true\n" +
  "---\n\n";
const TITLE = `# ${BANNER}\n\n` + "Recalled notes from prior sessions, about the user and this project.\n\n";
const HEADER = FRONTMATTER + TITLE;
/** Cursor documents no `additional_context` cap; the block uses the one shared budget
 *  (INJECT_BUDGET_BYTES, below), in UTF-8 bytes. MAX_CONTEXT_CHARS is the earlier name. */
export const MAX_CONTEXT_BYTES = 9000;
export const MAX_CONTEXT_CHARS = MAX_CONTEXT_BYTES;

const EMPTY_BODY = "_No memories recalled yet. They'll appear here as you work._\n";

// ── One line-sanitizer contract for every hook renderer (security batch B1: G1 + L1) ──
// Byte-for-byte mirror of atlaso_client/_render.py sanitize_line (read the contract
// there); the shared expectations live in client/tests/fixtures/sanitize_contract.json
// and run in pytest and bun test. In short: "remove only what can forge block structure
// or hide text; leave ordinary text byte-identical":
//   1. hidden code points are removed (non-whitespace Cc, Cs, Cf), except ZWNJ/ZWJ between
//      two visible non-ASCII characters (emoji ZWJ sequences, Indic/Persian text) and the
//      three RGI subdivision flag tag sequences;
//   2. whitespace follows the connector's pre-B1 spacing mode ("collapse", "join_lines",
//      "each_line"); no mode leaves a line break; ends trimmed;
//   3. a marker that forges a fence ('=' in the non-alphanumeric run right before or
//      after it, or a leading END) is replaced by "[fence]", with each adjacent run that
//      holds '=' (minus its outer space/tab padding); markers are found on a per-code-point
//      NFKC + lowercase view that skips kept joiners, tag characters and combining marks.
export type SpacingMode = "collapse" | "join_lines" | "each_line";
const SPACE = "\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
const BREAKS = "\n\x0b\x0c\r\x1c\x1d\x1e\x85\u2028\u2029";
const DROP_RE = /^[\p{Cc}\p{Cf}\p{Cs}]$/u;
const HIDDEN_NEIGHBOUR_RE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Zs}\p{Zl}\p{Zp}]$/u;
const MARK_RE = /^[\p{Mn}\p{Me}]$/u;
const TAG_FLAGS = ["gbeng", "gbsct", "gbwls"].map(
  (code) => "\u{1F3F4}" + Array.from(code, (c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("") + "\u{E007F}",
);
// Marker words may be separated by up to three non-alphanumeric characters.
const MARKER_RE = /(?:(?<![a-z0-9])end[^a-z0-9]{0,3})?atlaso[^a-z0-9]{0,3}(?:the[^a-z0-9]{0,3})?(?:memory|orientation|back[^a-z0-9]{0,3}of[^a-z0-9]{0,3}your[^a-z0-9]{0,3}mind)/u;
const FENCE_TOKEN = "[fence]";
// A credential-scrub marker in the folded (lowercased) view: [REDACTED] or [REDACTED:kind].
const SCRUB_MARK_RE = /\[redacted(?::[a-z0-9_]+)?\]/gu;
const PAD = " \t";

// Python str.isalnum on one code point of the folded view.
const ALNUM_RE = /^[\p{L}\p{N}]$/u;
const isAlnum = (c: string) => ALNUM_RE.test(c);
/** The code point starting at / ending just before UTF-16 index i ("" outside the string). */
const cpAt = (s: string, i: number) => (i < s.length ? String.fromCodePoint(s.codePointAt(i)!) : "");
const cpBefore = (s: string, i: number) => {
  if (i <= 0) return "";
  const lo = s.charCodeAt(i - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && i >= 2 && s.charCodeAt(i - 2) >= 0xd800 && s.charCodeAt(i - 2) <= 0xdbff
    ? s.slice(i - 2, i)
    : s.slice(i - 1, i);
};
const isJoiner = (c: string) => c === "\u200c" || c === "\u200d";
const visibleNonAscii = (c: string | undefined) =>
  c !== undefined && c.codePointAt(0)! >= 0x80 && !HIDDEN_NEIGHBOUR_RE.test(c);

/** Step 1: remove hidden code points; whitespace is left for step 2. */
function dropHidden(cps: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    if (c === "\u{1F3F4}") {
      const flag = TAG_FLAGS.find((f) => cps.slice(i, i + Array.from(f).length).join("") === f);
      out.push(flag ?? c);
      if (flag) i += Array.from(flag).length - 1;
    } else if (SPACE.includes(c)) out.push(c);
    else if (isJoiner(c)) {
      if (visibleNonAscii(cps[i - 1]) && visibleNonAscii(cps[i + 1])) out.push(c);
    } else if (!DROP_RE.test(c)) out.push(c);
  }
  return out;
}

/** Step 2: apply the connector's spacing mode to every whitespace run, then trim. */
function space(cps: string[], mode: SpacingMode): string {
  let out = "";
  for (let i = 0; i < cps.length; ) {
    if (!SPACE.includes(cps[i]!)) {
      out += cps[i++];
      continue;
    }
    let j = i;
    while (j < cps.length && SPACE.includes(cps[j]!)) j++;
    const run = cps.slice(i, j).join("");
    i = j;
    if (mode === "collapse" || (mode === "join_lines" && Array.from(run).some((c) => BREAKS.includes(c)))) out += " ";
    else if (mode === "each_line")
      out += Array.from(run.replaceAll("\r\n", "\n"), (c) => (BREAKS.includes(c) || c === "\x1f" ? " " : c)).join("");
    else out += run.replaceAll("\x1f", " ");
  }
  let a = 0;
  let b = out.length;
  while (a < b && SPACE.includes(out[a]!)) a++;
  while (b > a && SPACE.includes(out[b - 1]!)) b--;
  return out.slice(a, b);
}

const foldsToNothing = (ch: string) => {
  const cp = ch.codePointAt(0)!;
  return isJoiner(ch) || (cp >= 0xe0000 && cp <= 0xe007f) || MARK_RE.test(ch);
};

/** Per-code-point NFKC + lowercase view, plus for every folded UTF-16 unit the index of
 *  the original code point it came from. Kept joiners, tag characters and combining marks
 *  fold to nothing, so they cannot split a marker. */
function fold(s: string): [string, number[]] {
  if (/^[\x00-\x7f]*$/.test(s)) return [s.toLowerCase(), Array.from(s, (_, i) => i)];
  let out = "";
  const origin: number[] = [];
  for (let i = 0; i < s.length; ) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (!foldsToNothing(ch)) {
      const f = ch.normalize("NFKC").toLowerCase();
      out += f;
      for (let k = 0; k < f.length; k++) origin.push(i);
    }
    i += ch.length;
  }
  return [out, origin];
}

/** Step 3: replace every fence-forging marker (plus its '=' decoration) with FENCE_TOKEN
 *  in one left-to-right pass on the folded view. */
function neutralizeMarkers(s: string): string {
  const [folded, origin] = fold(s);
  const held = Array.from(folded.matchAll(SCRUB_MARK_RE), (m) => [m.index!, m.index! + m[0].length]);
  const inHeld = (i: number) => held.some(([x, y]) => x! <= i && i < y!);
  const re = new RegExp(MARKER_RE.source, "gu"); // u: separators count code points, as in Python
  let out = "";
  let pos = 0; // consumed prefix of s
  let posF = 0; // consumed prefix of folded
  for (let m = re.exec(folded); m; m = re.exec(folded)) {
    const a = m.index;
    const b = a + m[0].length;
    if (a < posF) continue;
    // The runs of non-alphanumeric characters right before and after the marker. It forges
    // a fence when either run holds '=' (or it starts with END); a run holding '=' is
    // replaced with the marker, minus the space/tab padding at its outer edge.
    // A run never reaches into a credential-scrub marker ("[REDACTED...]"): the hook line is
    // scrubbed before it is sanitized (redactLine), so a marker can sit right next to a fence
    // decoration and must keep its brackets. Mirrors Python `_in_scrub_marker`.
    let lo = a;
    for (let c = cpBefore(folded, lo); lo > posF && !isAlnum(c) && !inHeld(lo - c.length); c = cpBefore(folded, lo)) lo -= c.length;
    let hi = b;
    for (let c = cpAt(folded, hi); hi < folded.length && !isAlnum(c) && !inHeld(hi); c = cpAt(folded, hi)) hi += c.length;
    const pre = folded.slice(lo, a).includes("=");
    const post = folded.slice(b, hi).includes("=");
    if (!(pre || post || m[0].startsWith("end"))) continue;
    if (pre) while (PAD.includes(folded[lo]!)) lo++;
    else lo = a;
    if (post) while (PAD.includes(folded[hi - 1]!)) hi--;
    else hi = b;
    let start = origin[lo]!;
    const lastAt = origin[hi - 1]!;
    let end = lastAt + String.fromCodePoint(s.codePointAt(lastAt)!).length;
    // Never split a joiner, tag or combining sequence at the edges of the replacement.
    for (let c = cpBefore(s, start); start > pos && c && foldsToNothing(c); c = cpBefore(s, start)) start -= c.length;
    for (let c = cpAt(s, end); c && foldsToNothing(c); c = cpAt(s, end)) end += c.length;
    out += s.slice(pos, start) + FENCE_TOKEN;
    pos = end;
    posF = hi;
  }
  return out + s.slice(pos);
}

/** Cursor's pre-B1 spacing: each newline became one space, tabs were kept. */
const SPACING: SpacingMode = "each_line";
const FRONTMATTER_RE = /^---\s*$/gm;

/** Cursor's pre-B1 frontmatter guard, kept so ordinary notes keep their bytes: a line
 *  that is only `---` becomes `- - -` before the note is joined onto one line. (Joining
 *  alone already stops a note from opening .mdc frontmatter.) */
function guardFrontmatter(text: unknown): unknown {
  return typeof text === "string" ? text.trim().replace(FRONTMATTER_RE, "- - -") : text;
}

/** One stored string → one safe line, per the contract above. `mode` is the connector's
 *  spacing mode. A non-string or empty value renders as "". */
export function sanitizeLine(text: unknown, mode: SpacingMode = "collapse"): string {
  if (mode !== "collapse" && mode !== "join_lines" && mode !== "each_line") throw new Error(`unknown spacing mode ${mode}`);
  if (typeof text !== "string" || !text) return "";
  return neutralizeMarkers(space(dropHidden(Array.from(text)), mode));
}

/** Scrub/sanitize rounds `redactLine` runs after the raw-text scrub (Python
 *  `_render._REDACT_ROUNDS`). Each round only replaces matches with markers. */
const REDACT_ROUNDS = 4;

/** One stored string → one safe, credential-redacted line. Every note text and short form
 *  goes through this before it reaches the prompt, so a credential stored by an older
 *  client, an import, or in local-only/offline mode is replaced in place; the note is never
 *  dropped. Order (CodeRedTeam 8af8fbbe CRT-1): (1) scrub the text AS STORED (`redactText`),
 *  while line breaks still end values, so a quoted value with no closing quote is masked to
 *  the line end like the server masks it; (2) `sanitizeLine`; (3) scrub again and
 *  re-sanitize until a scrub removes nothing more (at most it relabels its own marker).
 *  The scrub is `scrub` in ./scrub (re-exported by ./capture: the server scrubber's full
 *  detection set and markers, ported with a drift test). Text with no credential keeps its
 *  bytes. Mirrors Python `_render.redact_line` (shared expectations:
 *  client/tests/fixtures/redact_contract.json). */
export function redactLine(text: unknown, mode: SpacingMode = "collapse"): string {
  if (typeof text !== "string" || !text) return sanitizeLine("", mode); // validates mode
  let line = sanitizeLine(redactText(text), mode);
  for (let round = 0; round < REDACT_ROUNDS; round++) {
    if (!line) return line;
    const [red] = scrub(line);
    // Nothing new removed: the canonical scrub relabels its own marker on a second pass in
    // URI userinfo ("[REDACTED]" <-> "[REDACTED:residue]"), so a label-only change is settled.
    if (unlabel(red) === unlabel(line)) return line;
    line = sanitizeLine(red, mode);
  }
  return line;
}

const SCRUB_LABEL_RE = /\[REDACTED(?::[a-z0-9_]+)?\]/gu;
/** `s` with every scrub marker written as plain `[REDACTED]` (Python `_render._unlabel`). */
const unlabel = (s: string): string => s.replace(SCRUB_LABEL_RE, "[REDACTED]");

/** Credential redaction for model-visible text that is NOT printed as a hook line (this
 *  plugin's MCP `recall` and `recent` results). Same `scrub` and markers as `redactLine`, but no sanitizing: spacing, line breaks and every other byte
 *  are left alone, so text with no credential is returned unchanged. Hidden characters are
 *  removed only when that is what exposes a split credential. Never drops the text; a
 *  non-string is returned as is. Mirrors Python `_render.redact_text` (rung c16ac87c). */
export function redactText<T>(text: T): T | string {
  if (typeof text !== "string" || !text) return text;
  const [red] = scrub(text);
  const bare = dropHidden(Array.from(red)).join("");
  if (bare !== red) {
    const [rejoined, kinds] = scrub(bare);
    if (kinds.length) return settle(rejoined);
  }
  return red === text ? text : settle(red);
}

/** Scrub already-scrubbed text again until a pass removes nothing (a label-only change is
 *  settled). Mirrors Python `_render._settle`. */
function settle(red: string): string {
  for (let round = 0; round < REDACT_ROUNDS; round++) {
    const [again] = scrub(red);
    if (unlabel(again) === unlabel(red)) return red;
    red = again;
  }
  return red;
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

// ── Injection budget (mirror of atlaso_client/_inject.py fit_lines; plugin/hook-budget) ──
// Hosts cap hook-injected text and degrade the whole block above the cap, so the block is
// fitted before it is returned: whole notes in rank order (a note's full line if it fits in
// the space left, else its short line, else the note is left out and the next is tried),
// room reserved for one closing "did not fit" line, never a note cut part way. Unit: UTF-8
// bytes, which is never less than the UTF-16 length or the code point count. Shared
// expectations: client/tests/fixtures/budget_contract.json (pytest + bun).
export const INJECT_BUDGET_BYTES = 9000;
/** The budget in force: ATLASO_INJECT_BUDGET=off (memo item 32 rollback switch) restores the
 *  pre-budget behaviour exactly, like atlaso_client._inject.budget_for. */
export function injectBudget(): number {
  return (process.env.ATLASO_INJECT_BUDGET || "").trim().toLowerCase() === "off"
    ? Number.MAX_SAFE_INTEGER : INJECT_BUDGET_BYTES;
}
const encoder = new TextEncoder();
export const utf8Bytes = (s: string): number => encoder.encode(s).length;

export interface Candidate {
  full: string;
  short: string | null;
  dated: boolean;
}

export function omittedLine(n: number): string {
  return `(${n} more note${n !== 1 ? "s" : ""} did not fit here. The Atlaso recall tool can show them.)`;
}

const OMIT_RESERVE = utf8Bytes(omittedLine(999)) + 1;

/** Whole lines for head + lines + tail within `budget` bytes, or null when the frame alone
 *  does not fit. `kept` are rank indices, `chosen` the line printed for each. */
export function fitLines(
  head: string, tail: string, cands: Candidate[], budget: number,
): { kept: number[]; chosen: string[]; omitted: number } | null {
  let room = budget - utf8Bytes(head) - utf8Bytes(tail) - OMIT_RESERVE;
  if (room < 0) return null;
  const kept: number[] = [];
  const chosen: string[] = [];
  cands.forEach((c, i) => {
    for (const l of [c.full, c.short]) {
      if (!l) continue;
      const cost = utf8Bytes(l) + 1;
      if (cost <= room) {
        kept.push(i);
        chosen.push(l);
        room -= cost;
        return;
      }
    }
  });
  return { kept, chosen, omitted: cands.length - kept.length };
}

/** The note's short form (the ranker's optional `short`), sanitized and redacted like its content, or
 *  null when absent, empty or no shorter than the content. Lengths compare code points. */
function shortContent(r: RecallResult, full: string, mode: SpacingMode): string | null {
  const s = redactLine(r.short, mode);
  return s && Array.from(s).length < Array.from(full).length ? s : null;
}

/** Stable partition: UNDATED lines first, then dated lines, each in recall order
 *  (mirrors Python `_render.undated_first`). A null created_at means the server
 *  could not justify an original statement time, so that line is never placed
 *  where a reader would take it for the newest note. */
export function undatedFirst(lines: Array<[boolean, string]>): string[] {
  return [...lines.filter(([d]) => !d), ...lines.filter(([d]) => d)].map(([, l]) => l);
}

/** One bullet per result, with conflict flag + peer count + scope (mirrors the
 *  Python recall_block): its full line and, when the ranker sent a shorter `short`, the
 *  same bullet around the short form. null if the content is empty. */
function line(r: RecallResult, now: Date): Candidate | null {
  const content = redactLine(guardFrontmatter(r.content), SPACING);
  if (!content) return null;
  const hd = !!r.has_disagreement;
  const date = dateLabel(r.created_at, now);
  const peers = Array.isArray(r.conflict_peers) ? r.conflict_peers.length : 0;
  const scope = sanitizeLine(r.scope, SPACING);
  const bullet = (c: string) => {
    let out = "- " + (date ? `[${date}] ` : "") + (hd ? "[conflict] " : "") + c;
    if (hd && peers) out += ` (conflicts with ${peers} other note${peers !== 1 ? "s" : ""})`;
    if (scope) out += `  [${scope}]`;
    return out;
  };
  const r2 = { ...r, short: typeof r.short === "string" ? (guardFrontmatter(r.short) as string) : r.short };
  const short = shortContent(r2, content, SPACING);
  return { full: bullet(content), short: short ? bullet(short) : null, dated: date !== null };
}

/** A user-facing notice at the top of the recalled block (Cursor has no terminal banner,
 *  so the session context the model reads is the only channel). Empty unless
 *  local-only/grace.
 *  Ported from the Python connectors' notice messages. */
export function noticeFor(mode: Verdict): string {
  const g = mode.grace;
  if (g && g.in_grace) {
    const d = g.days_left;
    const when = d != null && d <= 1 ? "Last day" : d != null ? `${d} days left` : "A few days left";
    return `> **Atlaso** · your Pro plan ended: Free keeps 1 tool. ${when} to upgrade at ${APP} and keep them all, or we'll keep your most-recently-used tool. Your memory stays safe.\n\n`;
  }
  if (mode.mode === LOCAL_ONLY) {
    if (mode.reason === NOT_ENTITLED)
      return `> **Atlaso** · Cursor isn't your active tool on the free plan: running local-only, so memory isn't syncing here. Switch tools or upgrade at ${APP} to use Atlaso memory in Cursor.\n\n`;
    if (mode.reason === REVOKED)
      return `> **Atlaso** · this device was disconnected: local-only. Reconnect at ${APP} to resume sync.\n\n`;
  }
  return "";
}

function candidates(results: RecallResult[], now: Date): Candidate[] {
  const out: Candidate[] = [];
  for (const r of results || []) {
    const c = line(r, now);
    if (c) out.push(c);
  }
  return out;
}

function recalledLines(results: RecallResult[], now: Date): string[] {
  return undatedFirst(candidates(results, now).map((c): [boolean, string] => [c.dated, c.full]));
}

/** The historical .mdc body (frontmatter + optional notice + recalled notes); an empty
 *  result yields a placeholder. Kept byte-stable as the parity reference; not delivered. */
export function render(results: RecallResult[], notice = "", now: Date = new Date()): string {
  const lines = recalledLines(results, now);
  const body = lines.length ? lines.join("\n") + "\n" : EMPTY_BODY;
  return HEADER + (notice || "") + body;
}

/** The sessionStart `additional_context`: the same block without frontmatter, fitted to
 *  `max` UTF-8 bytes by `fitLines` (whole notes in rank order, a note's short form when
 *  only that fits, a closing line counting the notes that did not fit). `extra` (a
 *  non-private hint) is appended after the notes. Empty when there is nothing to say (no
 *  notes, notice or hint), so an empty recall injects nothing. */
export function renderContext(
  results: RecallResult[], notice = "", now: Date = new Date(), extra = "", max = injectBudget(),
): string {
  const cands = candidates(results, now);
  if (!cands.length && !notice && !extra) return "";
  const head = TITLE + (notice || "");
  const tail = extra ? (cands.length ? "\n" : "") + extra + "\n" : "";
  if (!cands.length) return head + (notice ? EMPTY_BODY : "") + tail;
  const fit = fitLines(head, tail, cands, max);
  if (!fit) return utf8Bytes(head + tail) <= max ? head + tail : ""; // no room for any note line
  const lines = undatedFirst(fit.kept.map((i, k): [boolean, string] => [cands[i].dated, fit.chosen[k]]));
  if (fit.omitted) lines.push(omittedLine(fit.omitted));
  return head + lines.join("\n") + "\n" + tail;
}
