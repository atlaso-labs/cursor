/** Hook deadlines (rung "hooks never hang", 2026-09-30). Byte-identical in the Cursor and
 *  OpenCode connectors (tests/deadline.test.ts checks the copies match).
 *
 *  A host kills a hook at its own timeout and shows the user "hook timed out"; a stalled
 *  brain, DNS lookup, TLS handshake, lock or outbox drain must never get us there. So:
 *    - `within(work, ms)` races a piece of work against a deadline. The loser keeps running
 *      in the background; the caller must not let a late result change anything visible.
 *    - `armHardExit(ms, …)` ends a hook PROCESS at its deadline, exit 0, whatever is still in
 *      flight. It only fires between awaits, so a synchronous write (the outbox enqueue,
 *      the completion receipt) is never torn; an unsent outbox item is retried later.
 *    - `recordSkip(tool, event, reason)` appends one content-free line,
 *      `<epoch> <tool> <event> <reason>`, to <atlaso dir>/health/hooks.log: the same file
 *      and format as the Python connectors' guard, read by `atlaso status`.
 *  Nothing here retries or waits on a lock. */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** When this module was first evaluated: a hook imports it early, so start-up counts. */
export const STARTED_MS = Date.now();

/** Recall's whole budget, and the brain round trip's share of it. */
export const RECALL_BUDGET_MS = 2500;
export const NETWORK_BUDGET_MS = 1500;

const TOKEN = /^[a-z0-9_-]{1,32}$/;
const LOG_MAX_BYTES = 65536;

function atlasoDirForHealth(): string {
  return process.env.ATLASO_GLOBAL_PATH || process.env.ATLASO_PATH || join(homedir(), ".atlaso");
}

/** Milliseconds left until `STARTED_MS + budgetMs` (never negative). */
export function remaining(budgetMs: number): number {
  return Math.max(0, STARTED_MS + budgetMs - Date.now());
}

export function recordSkip(tool: string, event: string, reason: string): void {
  if (![tool, event, reason].every((f) => TOKEN.test(f))) return; // never text
  try {
    const d = join(atlasoDirForHealth(), "health");
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const f = join(d, "hooks.log");
    try {
      if (statSync(f).size > LOG_MAX_BYTES) renameSync(f, `${f}.1`);
    } catch {
      /* no file yet */
    }
    appendFileSync(f, `${Math.floor(Date.now() / 1000)} ${tool} ${event} ${reason}\n`, { mode: 0o600 });
  } catch {
    /* best-effort: a health line must never break a hook */
  }
}

export type Raced<T> = { done: true; value: T } | { done: false };

/** Race `work` against `ms`. A rejection inside `work` counts as done with `fallback`. */
export async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Raced<T>>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms));
  });
  const settled: Promise<Raced<T>> = work.then(
    (value) => ({ done: true as const, value }),
    () => ({ done: true as const, value: fallback }),
  );
  try {
    return await Promise.race([settled, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** End this hook process at `STARTED_MS + budgetMs`, exit 0, recording one skip line. */
export function armHardExit(budgetMs: number, tool: string, event: string): void {
  const t = setTimeout(() => {
    recordSkip(tool, event, "deadline");
    process.exit(0);
  }, remaining(budgetMs));
  (t as { unref?: () => void }).unref?.();
}

/** Write to stdout and wait until the bytes are handed to the OS, so a later exit (normal,
 *  or the hard deadline) cannot drop them. */
export function writeOut(s: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.stdout.write(s, () => resolve());
    } catch {
      resolve();
    }
  });
}
