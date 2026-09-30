/** Remove the recall files that older Atlaso versions wrote into the workspace.
 *
 * Security batch B1. Up to 0.2.4 the sessionStart hook wrote the user's recalled notes into
 * `<workspace>/.cursor/rules/atlaso-recall.mdc` (unreleased B1 round-2 builds also wrote a
 * refusal notice, `atlaso-notice.mdc`). No Git exclusion keeps a file in the workspace
 * private in every case: a repository's `.git/info/exclude` does not travel when the folder
 * is copied, and a `.gitignore` next to the file may stop Cursor from loading it. So 0.2.5
 * writes nothing into the workspace; recall reaches the session as sessionStart
 * `additional_context` (hooks/recall.ts), and this module deletes what older versions left.
 *
 * Only our own files go, by exact name AND content marker: a regular file whose first bytes
 * are the header Atlaso always wrote, or a temp file with Atlaso's exact temp-name shape. A
 * user's file of the same name without our header is kept.
 *
 * Links. When `.cursor` or `.cursor/rules` is a symbolic link, the folder it resolves to is
 * cleaned only if that folder is inside the workspace (its real path is the workspace or
 * below it): an old file there is one `git add -A` away from a commit (CodeRedTeam
 * f5332029). A link that leads outside the workspace is never followed for a delete; the
 * old file there is reported (`behindLink`) with a removal step for the user. The
 * containment check is repeated after entering the folder, on the process's real working
 * directory, so a folder swapped for a link between the check and the delete is caught.
 * Read-only toward everything that is not ours; never creates a directory; never throws.
 */
import {
  closeSync, constants, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, unlinkSync,
  type BigIntStats,
} from "node:fs";
import { join, sep } from "node:path";

export const RULES_DIR_REL = ".cursor/rules";
export const LEGACY_RECALL = "atlaso-recall.mdc";
export const LEGACY_NOTICE = "atlaso-notice.mdc";
export const LEGACY_RECALL_REL = `${RULES_DIR_REL}/${LEGACY_RECALL}`;

/** The first bytes every Atlaso-written legacy file starts with (render.ts HEADER since the
 *  first Cursor plugin, and the round-2 notice). */
const MARKERS: Record<string, string> = {
  [LEGACY_RECALL]: "---\ndescription: Atlaso long-term memory recalled for this session\n",
  [LEGACY_NOTICE]: "---\ndescription: Atlaso notice, recall is paused in this workspace\n",
};
/** Atlaso's temp-file shape: `.<name>.<pid>.<12 hex>.tmp` (the B1 round-2 atomic writer). */
const TEMP = /^\.atlaso-(recall|notice)\.mdc\.\d+\.[0-9a-f]{12}\.tmp$/;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

export interface LegacyCleanup {
  /** Names removed from `.cursor/rules`. */
  removed: string[];
  /** Set when an Atlaso recall file sits behind a symbolic-linked `.cursor` or
   *  `.cursor/rules` that leads OUTSIDE the workspace, and was left alone: the
   *  workspace-relative path to show. */
  behindLink: string | null;
}

function lstatOrNull(p: string): BigIntStats | null {
  try {
    return lstatSync(p, { bigint: true });
  } catch {
    return null;
  }
}

/** Does the regular file `p` start with `marker`? Never follows a final link, never blocks
 *  on a FIFO, reads at most the marker's length. */
function startsWith(p: string, marker: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(p, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const buf = Buffer.alloc(Buffer.byteLength(marker));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8") === marker;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const isPlainFile = (st: BigIntStats | null) => !!st && st.isFile() && !st.isSymbolicLink();

function ours(name: string): boolean {
  if (TEMP.test(name)) return isPlainFile(lstatOrNull(name));
  const marker = MARKERS[name];
  return !!marker && isPlainFile(lstatOrNull(name)) && startsWith(name, marker);
}

/** Is `p` (a real path) the workspace `ws` (a real path) or below it? */
export function insideWorkspace(ws: string, p: string): boolean {
  return p === ws || p.startsWith(ws.endsWith(sep) ? ws : ws + sep);
}

/** The user-facing sentence for an old recall file left behind an outside link. */
export function legacyFileNotice(path: string): string {
  return `An older Atlaso version left your recalled notes in \`${path}\`. That folder is a symbolic link to a place outside this workspace, so Atlaso did not delete it. Atlaso no longer writes that file; check it is the old Atlaso file and delete it with \`rm ${path}\` so it is never shared or committed.`;
}

/** Delete older versions' Atlaso files from the folder `<workspace>/.cursor/rules` resolves
 *  to, when that folder is inside the workspace. */
export function removeLegacyRules(workspace: string): LegacyCleanup {
  const result: LegacyCleanup = { removed: [], behindLink: null };
  let ws: string;
  try {
    ws = realpathSync(workspace);
  } catch {
    return result;
  }
  if (!lstatOrNull(join(ws, ".cursor"))) return result;
  const rulesPath = join(ws, ".cursor", "rules");
  let target: string;
  let dir: BigIntStats;
  try {
    target = realpathSync(rulesPath); // follows every link in the chain
    dir = statSync(target, { bigint: true });
  } catch {
    return result; // missing, dangling or unreadable: nothing to clean
  }
  if (!dir.isDirectory()) return result;
  if (!insideWorkspace(ws, target)) {
    // Report only; the target is not ours to modify.
    const legacy = join(target, LEGACY_RECALL);
    if (isPlainFile(lstatOrNull(legacy)) && startsWith(legacy, MARKERS[LEGACY_RECALL]!)) {
      result.behindLink = LEGACY_RECALL_REL;
    }
    return result;
  }

  let prevCwd: string | null = null;
  try {
    prevCwd = process.cwd();
  } catch {
    /* cwd removed; we return to the workspace instead */
  }
  let entered = false;
  try {
    // Every name below is relative to the entered directory, so a component swapped after
    // the check cannot redirect an unlink. Re-check what we entered: same directory as
    // checked, and its real path (from the kernel, not the string) still inside the workspace.
    process.chdir(target);
    entered = true;
    const here = lstatSync(".", { bigint: true });
    if (here.dev !== dir.dev || here.ino !== dir.ino) return result;
    if (!insideWorkspace(ws, realpathSync("."))) return result;
    for (const name of readdirSync(".")) {
      if (!ours(name)) continue;
      try {
        unlinkSync(name);
        result.removed.push(name);
      } catch {
        /* best effort; retried next session */
      }
    }
  } catch {
    /* unreadable directory: nothing removed */
  } finally {
    if (entered) {
      try {
        process.chdir(prevCwd ?? ws);
      } catch {
        /* the hook exits right after */
      }
    }
  }
  result.removed.sort();
  return result;
}
