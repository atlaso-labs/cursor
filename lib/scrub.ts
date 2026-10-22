/**
 * Credential scrub: a TypeScript port of the brain's pre-deposit scrubber
 * (atlaso/platform/sdk/src/atlaso/recall/scrub.py), plus one connector-only rule.
 *
 * Why a port: the connectors may not import the server-internal package (memo 16), and
 * a connector that knows fewer credential shapes than the server leaves them verbatim
 * in local-only and offline recall (CodeRedTeam c2d2ddcc F1). `scrubCore` must return
 * EXACTLY what the server's `scrub()` returns, text and kinds. That is enforced, not
 * hoped for: server/test_scrub_connector_parity.py runs the server scrubber, the Python
 * connector copy and this file (in tools/cursor AND tools/opencode, which hold identical
 * copies) over client/tests/fixtures/scrub_parity.json plus a seeded fuzz and fails on
 * any difference; tests/scrub_parity.test.ts checks this file against the fixture's
 * recorded server output on its own.
 *
 * Porting rules (Python `re` on str vs JavaScript RegExp with the `u` flag):
 *   - `\w` is Unicode in Python: W = [\p{L}\p{N}_]; `\b` is built from W with lookarounds;
 *   - `\s` is Python's str.isspace set (SP below), `\d` is \p{Nd};
 *   - `$` also matches before one final "\n" in Python: END = (?=\n?$);
 *   - lengths and slices that the server measures in code points use code points here
 *     (cpLen, the residue windows, the 12-code-point digest look-back);
 *   - sum() of floats is compensated (Neumaier) since CPython 3.12, so the entropy sum is too.
 * Known residual differences (outside the parity fixture): str.isdigit() also accepts
 * superscript and circled digits, which \p{Nd} does not; libm log2 may differ in the
 * last bit, which only matters when an entropy lands exactly on a threshold; Unicode
 * table versions may differ between the Python and JavaScript runtimes.
 *
 * Connector-only rule (runs AFTER `scrubCore`, in `scrub`): a QUOTED assignment value that
 * contains spaces is masked up to the next quote wherever the server's output still shows
 * part of it after `NAME=[REDACTED]`. The server masks such values whole itself (since
 * BackendEngineer bb9ce163); the rule now fires only where the two read quotes differently
 * (an unterminated quote), and this plugin's earlier capture scrub already had it. Running on the server's output and
 * only removing more keeps connector redaction a superset of the server's. The Python
 * connector (`_capture.scrub`) applies the same rule.
 * Scrub text only, never tags: the high-entropy catch-all damages long project keys.
 */

const W = "[\\p{L}\\p{N}_]";
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
// `\b` before a WORD character is "not preceded by a word character". Patterns that
// start with a literal match it first and check the boundary behind it (`lit` below):
// the same matches, but the engine can scan for the literal instead of trying a
// lookaround at every position.
const NB = `(?<!${W})`;
const lit = (prefix: string) => `${prefix}(?<!${W}${prefix})`;
const SP = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const S = `[${SP}]`;
const NS = `[^${SP}]`;
const D = "\\p{Nd}";
const END = "(?=\\n?$)";

// Python's case-insensitive matching (re.IGNORECASE on str) also accepts four non-ASCII
// letters for ASCII ones: U+0130 and U+0131 for i/I, U+017F for s/S, U+212A for k/K
// (simple case mappings). JavaScript `/iu` folds only U+017F and U+212A, and in Bun only
// for single letters, not for ranges such as [A-Za-z], so `VERİTABANI_PASSWORD=` passed
// verbatim (CodeRedTeam 8af8fbbe CRT-2). `pyCase` rewrites a case-insensitive source so
// every ASCII i/k/s letter, literal or inside a class (single or range, negated or not),
// also admits exactly those letters; the engine's own folding is not relied on.
const PY_FOLD: Record<string, string> = { i: "\\u0130\\u0131", k: "\\u212a", s: "\\u017f" };
const ESCAPE = /^\\(?:[pP]\{[^}]*\}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|c[A-Za-z]|k<[^>]*>|[\s\S])/;
const GROUP = /^\(\?(?:<[A-Za-z_][A-Za-z0-9_]*>|<[=!]|[:=!])/;
const foldsIn = (lo: string, hi: string): string =>
  Object.keys(PY_FOLD)
    .filter((c) => (lo <= c && c <= hi) || (lo <= c.toUpperCase() && c.toUpperCase() <= hi))
    .map((c) => PY_FOLD[c])
    .join("");

export function pyCase(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      const e = ESCAPE.exec(src.slice(i))![0];
      out += e;
      i += e.length;
    } else if (ch === "(" && src[i + 1] === "?") {
      // group syntax (?: (?= (?! (?<= (?<! (?<name>: a group name is not a pattern letter
      const g = GROUP.exec(src.slice(i));
      if (!g) throw new Error(`pyCase: unsupported group syntax at ${i}`);
      out += g[0];
      i += g[0].length;
    } else if (ch === "[") {
      let j = i + 1;
      let neg = "";
      let body = "";
      let extra = "";
      if (src[j] === "^") neg = src[j++];
      while (j < src.length && src[j] !== "]") {
        if (src[j] === "\\") {
          const e = ESCAPE.exec(src.slice(j))![0];
          body += e;
          j += e.length;
        } else if (src[j + 1] === "-" && j + 2 < src.length && src[j + 2] !== "]" && src[j + 2] !== "\\") {
          body += src.slice(j, j + 3);
          extra += foldsIn(src[j], src[j + 2]);
          j += 3;
        } else {
          body += src[j];
          extra += foldsIn(src[j], src[j]);
          j += 1;
        }
      }
      if (j >= src.length) throw new Error("pyCase: unterminated class");
      // Extra letters go FIRST: appended after a trailing literal "-" they would turn it
      // into a range ("_-\u0130" spans U+005F..U+0130). A body that starts with "-" gets
      // it escaped so the last extra letter cannot open a range either.
      out += "[" + neg + extra + (extra && body.startsWith("-") ? "\\" : "") + body + "]";
      i = j + 1;
    } else if (ch in PY_FOLD || ch.toLowerCase() in PY_FOLD) {
      out += `[${ch}${PY_FOLD[ch.toLowerCase()]}]`;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

const rx = (src: string, flags = "") => new RegExp(flags.includes("i") ? pyCase(src) : src, `u${flags}`);

// (kind, pattern). Order matters: specific shapes first, generic assignment last.
const PATTERNS: Array<[string, RegExp]> = [
  ["private_key", rx("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----", "g")],
  ["openai_anthropic_key", rx(`${lit("sk-")}[A-Za-z0-9_-]{16,}${B}`, "g")],
  ["github_token", rx(`${lit("(?:ghp|gho|ghu|ghs|ghr|github_pat)_")}[A-Za-z0-9_]{20,}${B}`, "g")],
  ["gitlab_token", rx(`${lit("glpat-")}[A-Za-z0-9_-]{16,}${B}`, "g")],
  ["aws_access_key", rx(`${lit("AKIA")}[0-9A-Z]{16}${B}`, "g")],
  ["google_api_key", rx(`${lit("AIza")}[0-9A-Za-z_-]{35}${B}`, "g")],
  ["slack_token", rx(`${lit("xox[baprs]-")}[A-Za-z0-9-]{10,}${B}`, "g")],
  ["stripe_secret_key", rx(`${lit("(?:[sr]k_(?:live|test)|whsec)_")}[A-Za-z0-9]{16,}${B}`, "g")],
  ["jwt", rx(`${lit("eyJ")}[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}${B}`, "g")],
  ["bearer", rx(`${lit("bearer")}${S}+[A-Za-z0-9._\\-]{16,}`, "gi")],
  ["uri_credential", rx(
    `${NB}([a-z][a-z0-9+.\\-]{1,30}://[^${SP}:/@"'\`]{0,64}:)(?!${D}{1,5}[?#])([^${SP}"'\`/]{1,128})@(?=[A-Za-z0-9\\[])`,
    "gi")],
  ["assignment", rx(
    `${NB}([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd|` +
    `access[_-]?key|client[_-]?secret|auth[_-]?token)[A-Za-z0-9_]*)` +
    `${S}*[:=]${S}*` +
    // the whole value (see the server's assignment pattern): quoted, closed by the same
    // quote glued to the value or by the end of the line/text; or unquoted, first token +
    // rest of the clause, stopping at the next credential name or prose label
    `(?:(["'])((?:(?!\\2)[^\\n]){3,256}?)(?:(?<!${S})\\2(?!${W})|(?=\\n|$))` +
    `|(["']?)([^${SP}"']{3,})` +
    `((?:[ \\t]+(?![A-Za-z0-9_.-]*[ \\t]*[:=])(?!#|//)` +
    `(?!${NS}*(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|auth[_-]?token))` +
    `(?!(?:pass(?:phrase|code|word)?|pin|otp|key|creds?|credentials?|login|cvv2?|cvc|code)(?!${W}))` +
    `(?:[^${SP}.;!?,()"'\`]|[.;!?,](?=${NS}))+){0,24})` +
    `(["']?))`,
    "gi")],
];

const HEX = rx("(?<![A-Za-z0-9])(?:0x)?([0-9a-fA-F]{48,})(?![A-Za-z0-9])", "g");
const DIGEST_PREFIX = rx(`(?:sha(?:1|256|512)|md5|digest|blake2b?)${S}*[:=]?${S}*${END}`, "i");
const BLOB = rx(`${B}[A-Za-z0-9+/=_-]{32,}${B}`, "g");
const ENTROPY_THRESHOLD = 4.2;

const STRONG =
  "password|passphrase|pass ?phrase|passcode|pass ?code|pass-?word|passwd|pwd|" +
  "pin(?: ?code| ?number)?|otp|one[- ]time (?:code|password|pin)|2fa code|mfa code|" +
  "verification code|security code|auth(?:entication)? code|access code|" +
  "recovery code|backup code|login code|sms code|cvv|cvc|cvv2";
const WEAK = "api ?key|secret(?: key)?|token|creds?|credentials?|login|key";
const QUAL =
  "(?:master |root |admin |temp(?:orary)? |old |new |current |door |wifi |wi-fi |account |db |database |server |ssh |vpn |sudo )?";
const LABEL = `${NB}(${QUAL}(?:${STRONG}|${WEAK}))${B}`;
const TARGET = "(?: (?:for|to|on|of) (?:my |the |our |his |her |their |your )?[\\p{L}\\p{N}_.@/-]{1,40})?";
const LINK =
  `(?:${S}*[,(?\\u2014:=\\-]*${S}*(?:it'?s|it is|that'?s|that is|which is|would be|should be)${S}+` +
  `|${S}+(?:is|was|are|were|reads|equals|remains|stays|becomes)(?:${S}+(?:set${S}+to|still|now|currently|just))?${S}*[:=]?${S}*` +
  `|${S}+(?:will|would|should|must|has to|needs to)${S}+be${S}*` +
  `|${S}*[:=\\u2014→]${S}*|${S}*-+>${S}*` +
  `|${S}*\\?${S}+)`;
const PROSE = rx(`${LABEL}${TARGET}${LINK}(?=(?<rest>[^\\n]{0,96}))`, "gi");
const IMPERATIVE = rx(
  `${NB}(?:enter|type|use|try|input|dial|punch in|key in|send|paste|put in|type in|` +
  `submit|provide|give|share)${S}+(?:the |your |my |this |our |a |that )?${LABEL}${TARGET}` +
  `(?:${S}+(?:is|of|as|:|=))?${S}*(?=(?<rest>[^\\n]{0,96}))`,
  "gi");
const VALUE_FIRST = rx(
  `(?:(["'\`])(?<q>(?:(?!\\1)[^\\n]){4,64})\\1|(?<![\\p{L}\\p{N}_/])(?<u>[^${SP}"'\`,;()]{4,64}))` +
  `${S}+(?:is|was|=|:)${S}+(?:the|my|your|our|his|her|their|a|an)${S}+` +
  `(?:new |current |old |door |admin |root |wifi |account )?(?:${STRONG}|${WEAK})${B}`,
  "gid");
const STRONG_ANY = rx(`${NB}(?:${STRONG})${B}`, "i");
const NEAR_LABEL =
  `${NB}(${QUAL}(?:${STRONG}|api ?key|secret(?: key)?|access key|private key|` +
  `signing key|auth token|token|creds?|credentials?))${B}`;
const LABEL_NEAR_BLOB = rx(
  `${NEAR_LABEL}(?:(?!\\[REDACTED)[^\\n]){0,40}?(?<![\\p{L}\\p{N}_/+=-])([A-Za-z0-9+/=_-]{16,})(?![\\p{L}\\p{N}_/+=-])`,
  "gid");
const IDENTIFIER_LIKE = rx(
  `^[a-z]+(?:[A-Z]{1,5}[a-z]+)+${D}{0,3}${END}|^[a-z]+(?:_[a-z]+)+(?:_?${D}{1,3})?${END}`);
const IDENTIFIER_ENTROPY_MAX = 4.0;
const KEYLIKE_ENTROPY = 3.5;
const PUBLISHABLE = rx(`^pk_(?:live|test)_[A-Za-z0-9]{8,}${END}`);
const PUBLISHABLE_ASSIGN = rx(`^[A-Z][A-Z0-9_]{0,40}=pk_(?:live|test)_[A-Za-z0-9]{8,}${END}`);
const FILENAME_LIKE = rx(`\\.[A-Za-z0-9]{1,5}${END}`);
const PLAIN_WORDS = rx("^[a-z_ .,;:'\\-]+$");
const STRONG_RE = rx(`^${QUAL}(?:${STRONG})${END}`, "i");
const MULTIWORD_RE = rx(`^${QUAL}(?:password|passphrase|pass ?phrase|pass-?word|passwd|pwd)${END}`, "i");
const LEADING_DETERMINER = rx(`^(?:the|a|an|my|your|our)${S}+`, "i");
const QUOTED = rx(`^(["'\`])(?<v>(?:(?!\\1)[^\\n]){4,64})\\1`);
const CLAUSE = rx(`^(?:[^\\n.;!?,()"'\`]|[.;!?,](?=${NS})){1,96}`);
const TOKENS = rx(`${NS}+`, "g");
const MARKER = /^\[REDACTED(?::[a-z_]+)?\]$/u;

const STOPWORDS = new Set([
  "wrong", "incorrect", "correct", "invalid", "valid", "expired", "expiring",
  "required", "optional", "missing", "empty", "null", "none", "unset", "nil",
  "disabled", "enabled", "locked", "unlocked", "blocked", "reset", "changed",
  "changing", "rotated", "rotating", "revoked", "compromised", "leaked",
  "exposed", "stolen", "secure", "insecure", "strong", "weak", "safe",
  "unsafe", "hidden", "stored", "saved", "hashed", "salted", "encrypted",
  "redacted", "masked", "managed", "case-sensitive", "different", "identical",
  "unchanged", "temporary", "permanent", "unknown", "forgotten",
  "confidential", "sensitive", "working", "broken", "fine", "okay", "ok",
  "still", "already", "probably", "definitely", "actually", "really", "very",
  "too", "also", "just", "not", "never", "always", "the", "same", "that",
  "this", "what", "available", "unavailable", "mandatory", "deprecated",
  "configured", "generated", "randomly", "automatically", "default",
  "public", "private", "active", "inactive", "production", "example",
  "placeholder", "dummy", "fake", "test", "sample", "sms", "email", "long",
  "short", "simple", "complex", "complicated", "random", "unique", "shared",
  "personal", "global", "local", "usually", "sometimes", "currently", "now",
  "here", "there", "below", "above", "attached", "included", "provided",
  "given", "needed", "used", "set", "sent", "shown", "listed", "defined",
  "documented", "described", "true", "false", "yes", "no", "undefined",
  "in", "on", "at", "a", "an", "my", "your", "our", "his", "her", "their",
  "its", "as", "of", "to", "for", "with", "by", "from", "and", "or", "but",
  "if", "when", "where", "how", "why", "something", "anything", "nothing",
  "whatever", "either", "neither", "both", "all", "only", "about", "like",
  "basically", "literally", "obviously", "apparently",
]);
const FUNCTION_WORDS = new Set([
  "the", "a", "an", "as", "of", "to", "for", "in", "on", "at", "and", "or",
  "not", "is", "was", "are", "with", "that", "this", "it", "by", "from",
  "my", "your", "his", "her", "its", "our", "their", "if", "so", "than",
  "then", "but", "be", "been", "being", "no", "yes",
]);
const SPEC_VALUE = rx(
  `^(?:${W}+\\(${D}+(?:,${S}*${D}+)?\\)` +
  `|${D}+${S}*-${S}*${D}+` +
  "|bearer|basic|digest|hmac|oauth2?|jwt|saml|sso|totp|hotp|ldap" +
  `|<[^>]*>|\\{\\{[^\\n]*\\}\\}|\\$\\{?${W}+\\}?` +
  "|[a-z]+-(?:only|based|specific|style|free|less)" +
  `|(?:str|string|int|integer|bool|boolean|uuid|text|varchar|char|bytes)${B}` +
  `)[.,;:!?]*${END}`,
  "i");

// ── Python str helpers ───────────────────────────────────────────────────────
const LSTRIP = rx(`^${S}+`);
const RSTRIP = rx(`${S}+$`);
const cpLen = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};
const pyStrip = (s: string): string => s.replace(LSTRIP, "").replace(RSTRIP, "");
const pyLstrip = (s: string): string => s.replace(LSTRIP, "");
function rstripChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
}
function stripChars(s: string, chars: string): string {
  let start = 0;
  while (start < s.length && chars.includes(s[start]!)) start++;
  return rstripChars(s.slice(start), chars);
}
/** Python `str.split()` with no argument: runs of whitespace, no empty strings. */
const pySplit = (s: string): string[] => s.split(rx(`${S}+`)).filter((w) => w.length > 0);
const isAlpha = (s: string): boolean => /^\p{L}+$/u.test(s);
const isLower = (s: string): boolean => !/[\p{Uppercase}\p{Lt}]/u.test(s) && /\p{Lowercase}/u.test(s);
const isDigits = (s: string): boolean => /^\p{Nd}+$/u.test(s);

/** CPython 3.12+ `-sum((c/n)*log2(c/n) for c in Counter(s).values())`, compensated. */
function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  let n = 0;
  for (const c of s) {
    counts.set(c, (counts.get(c) || 0) + 1);
    n++;
  }
  let total = 0;
  let comp = 0;
  for (const c of counts.values()) {
    const x = (c / n) * Math.log2(c / n);
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) comp += (total - t) + x;
    else comp += (x - t) + total;
    total = t;
  }
  if (comp && Number.isFinite(comp)) total += comp;
  return -total;
}

/** Python `pattern.sub(fn, s)`: non-overlapping matches over the ORIGINAL string. */
function sub(re: RegExp, s: string, fn: (m: RegExpExecArray) => string): string {
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  for (const m of s.matchAll(re)) {
    out += s.slice(last, m.index) + fn(m as RegExpExecArray);
    last = m.index! + m[0].length;
  }
  return out + s.slice(last);
}

const isIdentifier = (tok: string): boolean => IDENTIFIER_LIKE.test(tok) && entropy(tok) < IDENTIFIER_ENTROPY_MAX;

function looksCredentialShaped(value: string): boolean {
  if (/\p{Nd}/u.test(value)) return true;
  if (/\p{Uppercase}/u.test(value) && /\p{Lowercase}/u.test(value)) return true;
  if (/[^\p{L}\p{N}]/u.test(value)) return true;
  return cpLen(value) >= 8;
}

function vetValue(value: string, strong: boolean): boolean {
  const v = rstripChars(pyStrip(value), ".!?,;:");
  if (cpLen(v) < 4 || v.includes("REDACTED")) return false;
  if (STOPWORDS.has(v.toLowerCase()) || SPEC_VALUE.test(v) || PUBLISHABLE.test(v)) return false;
  if (strong) return true;
  return looksCredentialShaped(v);
}

/** Offsets in `rest` of the value to redact (see the server's `_pick_value`). */
function pickValue(rest: string, strong: boolean, multiword = false): [number, number] | null {
  let lead = rest.length - pyLstrip(rest).length;
  let body = rest.slice(lead);
  if (!body) return null;
  if (strong) {
    const d = LEADING_DETERMINER.exec(body);
    if (d) {
      lead += d[0].length;
      body = body.slice(d[0].length);
    }
  }
  const q = QUOTED.exec(body);
  if (q) return vetValue(q.groups!.v!, strong) ? [lead + q.index, lead + q.index + q[0].length] : null;
  const clause = CLAUSE.exec(body);
  if (!clause) return null;
  const c = clause[0];
  const words = [...c.matchAll(TOKENS)];
  if (!words.length) return null;
  const span = (a: RegExpMatchArray, b: RegExpMatchArray): [number, number] => {
    let end = b.index! + b[0].length;
    while (end > a.index! && ".,;:!?".includes(c[end - 1]!)) end--;
    return [lead + a.index!, lead + end];
  };
  if (multiword && words.length >= 2 && isAlpha(words[0]![0])) {
    const run: RegExpMatchArray[] = [];
    for (const w of words.slice(0, 6)) {
      const lw = rstripChars(w[0].toLowerCase(), ".,;:!?");
      if (FUNCTION_WORDS.has(lw) || SPEC_VALUE.test(w[0])) break;
      run.push(w);
    }
    if (run.length >= 2 && !run.every((w) => STOPWORDS.has(rstripChars(w[0].toLowerCase(), ".,;:!?")))) {
      return span(run[0]!, run[run.length - 1]!);
    }
  }
  const first = words[0]!;
  return vetValue(first[0], strong) ? span(first, first) : null;
}

type Residue = Array<[string, boolean]>;

function applyProse(re: RegExp, text: string, found: string[], residue: Residue): string {
  let out = text;
  let pos = 0;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(out);
    if (!m) return out;
    const label = m[1]!;
    const strong = STRONG_RE.test(label);
    const rest = m.groups!.rest!;
    const end = m.index + m[0].length;
    const span = pickValue(rest, strong, MULTIWORD_RE.test(label));
    if (!span) {
      pos = end;
      continue;
    }
    const [s, e] = span;
    const value = rest.slice(s, e);
    found.push("prose_credential");
    residue.push([value, entropy(value) >= KEYLIKE_ENTROPY]);
    const prefix = out.slice(0, end) + rest.slice(0, s) + "[REDACTED]";
    out = prefix + out.slice(end + e);
    pos = prefix.length;
  }
}

function windowsOf(s: string, win: number): Set<string> {
  const cp = Array.from(s);
  const out = new Set<string>();
  for (let k = 0; k + win <= cp.length; k++) out.add(cp.slice(k, k + win).join(""));
  return out;
}

function sweepExact(out: string, v: string, windows: Set<string>): [string, boolean] {
  if (!v) return [out, false];
  const win = 12;
  const vcp = Array.from(v);
  if (isDigits(v) && vcp.length < win) {
    // digits only: no character here needs escaping
    let n = 0;
    const next = out.replace(rx(`(?<![0-9])${v}(?![0-9])`, "g"), () => {
      n++;
      return "[REDACTED:residue]";
    });
    return n ? [next, true] : [out, false];
  }
  if (vcp.length >= win && !windows.has(vcp.slice(0, win).join(""))) return [out, false];
  if (!out.includes(v)) return [out, false];
  return [out.split(v).join("[REDACTED:residue]"), true];
}

function residueSweep(text: string, values: Residue): [string, boolean] {
  let out = text;
  let hit = false;
  const win = 12;
  let windows: Set<string> | null = null;
  for (const [raw, fragmentsOk] of values) {
    const v = pyStrip(raw);
    const vcp = Array.from(v);
    if (!v || vcp.length > 256) continue;
    const ent = entropy(v);
    if (windows === null) windows = windowsOf(out, win);
    if (!(fragmentsOk && vcp.length >= win && ent >= KEYLIKE_ENTROPY)) {
      const [next, h] = sweepExact(out, v, windows);
      out = next;
      hit = hit || h;
      continue;
    }
    let i = 0;
    while (i + win <= vcp.length) {
      let frag = vcp.slice(i, i + win).join("");
      if (frag.includes("REDACTED") || PLAIN_WORDS.test(frag)) {
        i++;
        continue;
      }
      if (!windows.has(frag)) {
        i++;
        continue;
      }
      const at = out.indexOf(frag);
      if (at < 0) {
        windows.delete(frag);
        i++;
        continue;
      }
      const ocp = Array.from(out);
      const p = cpLen(out.slice(0, at));
      let j = i + win;
      while (j < vcp.length && p + (j - i) < ocp.length && ocp[p + (j - i)] === vcp[j]) j++;
      frag = vcp.slice(i, j).join("");
      out = out.split(frag).join("[REDACTED:residue]");
      hit = true;
      i = j;
    }
    const [next, h] = sweepExact(out, v, windows);
    out = next;
    hit = hit || h;
  }
  return [out, hit];
}

/** The server scrubber, ported: `[scrubbedText, kindsRedacted]`, text NFC-normalized. */
export function scrubCore(input: string): [string, string[]] {
  if (!input) return [input, []];
  const text = input.normalize("NFC");
  const found: string[] = [];
  const residue: Residue = [];
  let out = text;

  for (const [kind, re] of PATTERNS) {
    out = sub(re, out, (m) => {
      if (kind === "uri_credential") {
        found.push(kind);
        residue.push([m[2]!, true]);
        return `${m[1]}[REDACTED]@`;
      }
      if (kind === "assignment") {
        const quoted = m[2] !== undefined;
        let value = (quoted ? m[3] : m[5])!;
        const tail = quoted ? "" : m[6]!;
        let rest = tail ? tail + m[7]! : "";
        if (tail && !m[4] && isAlpha(value)) {
          // a passphrase run (see the server's `_assignment_repl`)
          const words = [value];
          let end = 0;
          for (const w of tail.matchAll(TOKENS)) {
            const lw = rstripChars(w[0].toLowerCase(), ".,;:!?");
            if (FUNCTION_WORDS.has(lw) || SPEC_VALUE.test(w[0])) break;
            words.push(w[0]);
            end = w.index! + w[0].length;
          }
          if (!FUNCTION_WORDS.has(value.toLowerCase()) && words.length >= 2 &&
              !words.every((w) => STOPWORDS.has(rstripChars(w.toLowerCase(), ".,;:!?")))) {
            while (end > 0 && ".,;:!?".includes(tail[end - 1]!)) end--;
            value += tail.slice(0, end);
            rest = tail.slice(end) ? tail.slice(end) + m[7]! : "";
          }
        }
        if (MARKER.test(value)) return m[0];
        if (SPEC_VALUE.test(value) || PUBLISHABLE.test(value)) return m[0];
        if (quoted && pySplit(value).length > 1) {
          const plain = (w: string) => {
            const lw = stripChars(w.toLowerCase(), ".,;:!?");
            return STOPWORDS.has(lw) || FUNCTION_WORDS.has(lw);
          };
          if (pySplit(value).every(plain)) return m[0];
        } else if (pySplit(value).length === 1 && cpLen(value) < 6 &&
                   STOPWORDS.has(rstripChars(value.toLowerCase(), ".,;:!?"))) {
          return m[0];
        }
        found.push(kind);
        const parts = pySplit(value);
        if (parts.length > 1) residue.push([value, false]); // whole value first
        parts.forEach((part, i) => {
          if (parts.length === 1 || i === 0 || (cpLen(rstripChars(part, ".,;:!?")) >= 3 && !isAlpha(rstripChars(part, ".,;:!?")))) {
            const tok = parts.length === 1 || i === 0 ? part : rstripChars(part, ".,;:!?");
            residue.push([tok, entropy(tok) >= KEYLIKE_ENTROPY && !FILENAME_LIKE.test(rstripChars(tok, "!?.,;:"))]);
          }
        });
        return `${m[1]}=[REDACTED]${rest}`;
      }
      found.push(kind);
      residue.push([m[0], true]);
      return `[REDACTED:${kind}]`;
    });
  }

  const hexSource = out;
  out = sub(HEX, out, (m) => {
    const before = Array.from(hexSource.slice(Math.max(0, m.index - 24), m.index)).slice(-12).join("");
    if (DIGEST_PREFIX.test(before)) return m[0];
    found.push("hex_secret");
    residue.push([m[1]!, true]);
    return "[REDACTED:hex_secret]";
  });

  out = applyProse(PROSE, out, found, residue);
  out = applyProse(IMPERATIVE, out, found, residue);

  out = sub(VALUE_FIRST, out, (m) => {
    const which = m.groups!.q ? "q" : "u";
    const value = (m.groups!.q || m.groups!.u)!;
    const groupEnd = m.indices!.groups![which]![1];
    const labelText = m[0].slice(groupEnd - m.index + (which === "q" ? 1 : 0));
    const strong = STRONG_ANY.test(labelText);
    if (!vetValue(value, strong)) return m[0];
    found.push("prose_credential");
    residue.push([value, entropy(value) >= KEYLIKE_ENTROPY]);
    return `[REDACTED]${labelText}`;
  });

  out = sub(LABEL_NEAR_BLOB, out, (m) => {
    const blob = m[2]!;
    if (m[0].includes("REDACTED") || SPEC_VALUE.test(blob)) return m[0];
    if (STOPWORDS.has(blob.toLowerCase()) || (isAlpha(blob) && isLower(blob))) return m[0];
    if (isIdentifier(blob) || PUBLISHABLE.test(blob)) return m[0];
    found.push("label_adjacent_blob");
    residue.push([blob, true]);
    const [s2, e2] = m.indices![2]!;
    return m[0].slice(0, s2 - m.index) + "[REDACTED]" + m[0].slice(e2 - m.index);
  });

  out = sub(BLOB, out, (m) => {
    const tok = m[0];
    if (tok.includes("REDACTED") || PUBLISHABLE.test(tok) || PUBLISHABLE_ASSIGN.test(tok)) return tok;
    if (entropy(tok) >= ENTROPY_THRESHOLD) {
      found.push("high_entropy");
      residue.push([tok, true]);
      return "[REDACTED:high_entropy]";
    }
    return tok;
  });

  const [swept, hit] = residueSweep(out, residue);
  if (hit) found.push("residue");
  return [swept, found];
}

const ASSIGN_NAME =
  "[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd|" +
  "access[_-]?key|client[_-]?secret|auth[_-]?token)[A-Za-z0-9_]*";
const QUOTED_MULTIWORD_ASSIGNMENT = rx(
  `${NB}(${ASSIGN_NAME})${S}*[:=]${S}*(?:"(?=[^"\\n]*${S})[^"\\n]{2,256}"|'(?=[^'\\n]*${S})[^'\\n]{2,256}')`,
  "gi");
const QUOTED_TAIL = rx(`${NB}(${ASSIGN_NAME})=\\[REDACTED\\](?=[^"'\\n]*${S})[^"'\\n]{1,256}["']`, "gi");

/** Connector scrub: `scrubCore`, then the quoted-tail rule (when the text holds a quoted
 *  assignment value with spaces, the rest of that value after the server's
 *  `NAME=[REDACTED]` is masked up to the closing quote). It runs on the server's output
 *  and only removes more, so it is a superset of the server's redaction by construction.
 *  Returns the ORIGINAL string and no kinds when nothing is found, so a clean note keeps
 *  its bytes. Mirrors Python `atlaso_client._capture.scrub`. */
export function scrub(text: string): [string, string[]] {
  if (!text) return [text, []];
  let [out, found] = scrubCore(text);
  QUOTED_MULTIWORD_ASSIGNMENT.lastIndex = 0; // global regex: .test() is stateful
  if (QUOTED_MULTIWORD_ASSIGNMENT.test(text)) {
    const mask = (m: RegExpExecArray) => {
      found = [...found, "assignment"];
      return `${m[1]}=[REDACTED]`;
    };
    out = sub(QUOTED_TAIL, out, mask); // the server masked the first word: mask the rest
    out = sub(QUOTED_MULTIWORD_ASSIGNMENT, out, mask); // the server left the value whole
  }
  return found.length ? [out, found] : [text, []];
}
