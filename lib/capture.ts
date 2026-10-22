/** Commodity capture heuristics — NOT the IP.
 *
 * Simple regex/string helpers (a chatter gate, scope router, polarity hint,
 * secret scrub) that decide WHETHER and HOW to send a capture to the server.
 * None of the proprietary engine lives here — that stays on the brain. Ported
 * 1:1 from the Python thin client's `_capture.py` so the bun connector keeps the
 * same capture quality. The server re-scrubs + runs the real worth-keeping gate.
 */
import { createHash } from "node:crypto";

// ── worth-keeping gate ───────────────────────────────────────────────────────
const CHATTER =
  /^(?:ok(?:ay)?|k|thx|thanks?|thank you|ty|yes|yep|yeah|yup|no|nope|sure|cool|nice|great|awesome|perfect|lgtm|got it|continue|go ahead|do it|please do|proceed|run it|run the tests?|next|stop|wait|hmm+|ah|oh|nvm|never ?mind)[\s.!?]*$/i;
// Meta / recall-REQUEST: the user asking the agent to USE its memory, or asking a
// question about themselves — NOT stating a durable fact. These routinely trip a
// SIGNAL keyword ("use your memory", "what do I prefer…?") yet are worthless to keep,
// so they're checked BEFORE signal. Declarative facts ("I always use pnpm") don't
// match — they have no memory-verb + memory-object pairing and aren't interrogative.
const META_RECALL = new RegExp(
  [
    String.raw`\b(?:use|using|check|search|query|consult|look\s*up|pull|fetch)\b[^.?!]{0,40}\bmemor(?:y|ies)\b`, // "use your atlaso memory"
    String.raw`\brecall\b[^.?!]{0,40}\b(?:memor(?:y|ies)|from\s+my|what|which|my)\b`, // "recall from my memory / recall what…"
    String.raw`\bdo you (?:remember|recall|know)\b`, // "do you remember…"
    String.raw`\bwhat(?:'?s| is| are| was| were| do i| did i)\b[^.?!]{0,60}\bmy\b[^.?!]{0,60}\?`, // "what's my favorite …?"
  ].join("|"),
  "i",
);
const SIGNAL =
  /\b(prefer|always|never|don'?t|do not|avoid|use\b|using|i like|we should|should (?:always|never|use)|remember|note that|going with|decided|rule:|important|make sure|ensure|must\b|need to|require|my .+ is\b|the .+ is\b)\b/i;
const MIN_WORDS = 4;

export function shouldDeposit(userText: string): [boolean, string] {
  const t = (userText || "").trim();
  if (!t) return [false, "empty"];
  if (CHATTER.test(t)) return [false, "chatter"];
  // A recall-request / self-question is never a durable fact — drop it before the
  // SIGNAL keywords ("use", "prefer") can rescue it as a false positive.
  if (META_RECALL.test(t)) return [false, "meta_recall"];
  if (SIGNAL.test(t)) return [true, "signal"];
  if (t.split(/\s+/).length < MIN_WORDS) return [false, "too_short"];
  return [true, "substantive"];
}

export function heuristicPolarity(userText: string): string {
  const t = (userText || "").toLowerCase();
  if (/\b(never|don'?t|do not|avoid|stop|doesn'?t work|didn'?t work|fails?|failed|broke|broken|bug|wrong|bad)\b/.test(t))
    return "cautionary";
  if (/\b(prefer|always|use|like|love|want|should|works?|good)\b/.test(t)) return "positive";
  return "open";
}

// ── scope router (personal/global vs project) ────────────────────────────────
const PERSONAL =
  /\b(i (?:prefer|like|love|always|usually|tend to|never|hate|avoid)\b|my (?:favou?rite|preferred|default|usual|go-?to|style|setup|workflow)\b|for all my (?:projects|repos)\b|i'?m a .*?(?:person|developer|engineer)\b)/i;
const EXPLICIT_PROJECT =
  /\b(?:this (?:project|repo|codebase|app|service)|in this (?:repo|project))\b/i;
const PROJECT =
  /(?:\b(?:the (?:server|database|db|api|endpoint|service|build|deploy(?:ment)?|schema)\b|localhost|127\.0\.0\.1|\b\d{1,3}(?:\.\d{1,3}){3}\b)|\/[\w.\-]+\/[\w./\-]+)/i;

export function classifyScope(userText: string): string {
  const t = userText || "";
  // An explicit "this repo/project" phrase wins, but a generic path/API mention
  // must not trap an otherwise clear personal preference in one repository.
  if (EXPLICIT_PROJECT.test(t)) return "project";
  if (PERSONAL.test(t)) return "personal";
  if (PROJECT.test(t)) return "project";
  return "project"; // default: contain locally rather than pollute global
}

export function buildContent(userText: string, asstText: string): string {
  let content = (userText || "").trim();
  const a = (asstText || "").trim();
  if (a) content += `\n\n(assistant: ${a.slice(0, 400)})`;
  return content.trim();
}

/** Content-free fingerprint used to match a stop deposit with a later sessionEnd
 *  fallback. Whitespace normalization tolerates transcript serialization differences
 *  without persisting the user's message in the completion receipt. */
export function messageKey(userMsg: string): string {
  const normalized = (userMsg || "").trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/** Deterministic per-turn idempotency key (the deposit's client_id). Derived from the
 *  USER message — the stable identity of a turn — NOT the assembled user+assistant
 *  content. This is load-bearing: `stop` may deposit a user-only turn while a late
 *  `afterAgentResponse` re-stashes user+assistant that a later `sessionEnd` then
 *  deposits. Keying on the assembled content would give those two DIFFERENT keys → a
 *  near-duplicate memory; keying on the user message collapses them to ONE (assistant
 *  text is best-effort enrichment, not identity). Scope + project keep the SAME
 *  statement in a DIFFERENT project distinct (server idempotency window is per
 *  (user, key), ~7 days). */
export function turnKey(userMsg: string, scope: string, project: string | null): string {
  return createHash("sha256")
    .update(`${scope} ${project ?? ""} ${userMsg}`)
    .digest("hex")
    .slice(0, 32);
}

// ── secret scrub (defense-in-depth; the server re-scrubs too) ────────────────
// The server's full detection set plus the connector-only quoted-assignment rule, in
// ./scrub (a port of atlaso/platform/sdk/src/atlaso/recall/scrub.py with a drift test).
// Returns [scrubbed, kindsFound]; the original string when nothing is found.
export { scrub } from "./scrub";
