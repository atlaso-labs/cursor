# Changelog

## [0.2.6] - 2026-10-01

Hooks never hold up a session. Session-start recall gives up after 2.5 s and hands Cursor the session context before it catches up on queued notes; every Atlaso hook now ends within 8 s (Cursor allows 50), and a queued note cut off mid-send is sent on a later turn. Each skip is counted on this device as a time, tool and reason, never any text, and `atlaso status` shows the count for the last 24 hours, with skipped recall and interrupted saving listed separately.

A finished turn is now written to this device before Atlaso checks your plan or credential, so a slow Atlaso server can no longer lose it when the hook stops at its time limit. It becomes uploadable only after that check allows it: until then no other hook can send it, and a tool that is local-only on your plan never uploads it. A turn whose hook stopped before the check is decided, and sent once if allowed, by the next Cursor hook.

Reconnecting a saved device renews that same device. Atlaso now keeps a reconnect proof, issued when you connect, in the owner-only auth file on this device and sends it when this device reconnects.

## [0.2.5] - 2026-09-30

Security fixes (batch B1). A saved note can no longer add lines to the recalled memory block or fake the start or end of the memory block, and invisible control, zero-width and bidirectional-override characters are removed from recalled notes. Ordinary notes print exactly as before, tabs and emoji included; a note with Windows (CRLF) line endings no longer carries a stray carriage return.

Recall no longer writes your notes into the workspace. The sessionStart hook returns the recalled block as session context, capped at 9,000 characters, and writes nothing into the workspace. Newly recalled notes are returned as session context; if an older `.cursor/rules/atlaso-recall.mdc` remains, delete it with write access before copying or staging this folder. The old `.cursor/rules/atlaso-recall.mdc` (and any `atlaso-notice.mdc`) that Atlaso wrote is removed at the start of the first chat: the plugin removes the old private rules file first, before contacting Atlaso; in a read-only folder it cannot, and the file stays until you delete it with write access. A file of that name without Atlaso's header is kept. When `.cursor` or `.cursor/rules` is a symbolic link, the old file is deleted only if the link leads to a folder inside the workspace; if it leads outside, nothing there is touched and you are told the command to remove it. If Cursor drops the Atlaso Memory block, recall depends on the agent calling the `recall` tool when past context helps; automatic recall for that IDE path has not been verified.

## [0.2.4] - 2026-09-26

Dated recall lines. Each note in the injected memory block now starts with the latest UTC day you stated it, for example `- [Aug 14] use bun`. A note rewritten later by server-side enrichment keeps the day of the statement it restates, not the rewrite day. A note whose day is unknown shows no date and is listed first. Notes queued offline are sent with the time they were captured. Against a brain that does not return dates, lines stay undated.

In one synthetic bench run using the shared Python renderer, dates changed newest-decision accuracy from 117/150 to 126/150 for gpt-4.1-mini and from 131/150 to 132/150 for DeepSeek V4.1 Flash; Cursor and OpenCode date rendering was unit-tested, not measured in that run. On the other 244 recall questions the net change was +2 and +1. The same notes were injected with and without dates; only the dates differed. This is one run per reader, not a statistical certification.

Dated MCP results. The `recall` and `recent` memory tools now return `stated_on`, the day the user stated each note (YYYY-MM-DD), or null when that is unknown. It is the same day the injected block shows, never the day a note was stored, imported, synced or rewritten, and `recent` no longer returns the storage time. Covered by unit tests, not by the bench.

One memory skill. The judgment part of the memory skill is now one shared text, byte-identical in all seven Atlaso tools and checked by a parity test. It says to save a changed decision as a change that names both values and the reason and keep the old note, to forget only a memory that was never true, to name a return to an earlier choice as a change, and never to re-save something that was only read from memory. It adds a rule for reading notes that disagree: in the same scope the most recently stated note is current, an undated note is not newer, and when neither is clearly newer the model asks you. The forget wording from the previous release is kept. Not measured by the bench.

## [0.2.3] — 2026-09-26

Forget copy. The `forget` MCP tool no longer says it permanently deletes a memory; its description now reads: "Forget a memory by its id (ids come from recall/recent): removes it from your memory everywhere Atlaso recalls or exports it. Only when the user asks to forget something." The memory skill now says what forget does and that you can’t undo it. No other behavior changes. Product bytes equal the lab-gated emergence-lab commit 0578e74ac (CodeRedTeam bfe4497e, carried by byte identity 972f474e; DXCritic c27cb73e).

## [0.2.2] — 2026-09-23

New Atlaso logo: the plugin listing now shows the ten-dot mark on a black square. No behavior changes.

## [0.2.1] — 2026-09-21

Preserve nearest-package identity while recognizing managed worktrees, rejecting untrusted directories, and retaining exact long project keys. This updates capture/recall identity; it does not add SessionStart Ambient delivery.

All notable changes to the Atlaso Memory plugin for Cursor.

## [0.2.0] — 2026-08-02

### Added
- **Your memories now survive a bad connection.** A memory used to be sent once,
  and if anything went wrong — a timeout, a server hiccup, a dropped wifi
  connection — it was gone, with nothing kept locally and nothing to tell you.
  Every memory is now written to disk *before* it is sent and retried
  automatically on a later turn. A memory is never silently lost; if one truly
  cannot be delivered it is set aside with a reason rather than discarded.

### Fixed
- **Removing the plugin now really stops it, on Windows too.** On Windows the
  plugin could not obtain its own credential, so it never learned it had been
  removed and kept syncing.
- **Secrets stay on your machine.** Saving a memory explicitly, and searching
  your memory, are now scrubbed on-device like automatic capture already was.
- **Memory stays in the right project.** Per-project filtering now applies to
  the `recall` and `recent` tools, so one repository's notes no longer surface
  in another. Repositories cloned over SSH with a custom port no longer split
  into two separate projects.
- **Saving a memory no longer fails when the project can't be identified.** It
  is saved and marked instead of refused, and saving the same thing twice can no
  longer create a duplicate.
- `status` no longer reports "connected" when the server is unreachable.
- Concurrent tool calls can no longer interleave and corrupt the MCP transport.
- A preference that merely mentions a file path is no longer trapped in one repo.
- A valid credential is no longer discarded and re-minted on every run.

## [0.1.2] — 2026-07-25

### Fixed
- **Per-project memory now works.** Captures were being filed under a fake
  project derived from the plugin's own install folder, so project memories
  could not be recalled in the project they came from. Project detection now
  uses the workspace root from the hook event, and every candidate path is
  checked — tool-install, cache, and `$HOME` directories can never be mistaken
  for your project.
- **Unattributable captures stay visible.** When the workspace can't be
  determined, the memory is marked unattributed and remains recallable instead
  of being silently hidden.
- **Stable keys across spellings.** Project keys are now case- and
  Unicode-normalized, so the same folder always resolves to the same project.

## [0.1.1] — 2026-07-24

### Added
- **Capture-quality counters** — content-free daily counts of memory-worthy
  exchanges (attempts, accepted, drop reasons only; never any conversation
  content) so the dashboard's Capture quality tile can include Cursor. Counts
  piggyback on the existing end-of-session upload; nothing new leaves the
  machine when nothing changed.

### Fixed
- Cursor's `stop` + `sessionEnd` double-fire no longer double-counts a turn
  (same-key events within a short window are treated as one).

## [0.1.0] — 2026-07-15

Initial release.

### Added
- **Automatic memory loop** via Cursor hooks — `sessionStart` recalls relevant notes
  into a rules file; `stop`/`sessionEnd` capture the exchange. Zero model involvement.
- **`Atlaso` MCP server** — 5 tools (`recall`, `remember`, `forget`, `recent`,
  `status`) for deliberate memory moves, reusing the same per-device credential the
  hooks mint (one auth, one unlink).
- **Per-tool credentials** — the plugin holds its own token so "remove Cursor" revokes
  only Cursor. Never-brick: only a verified server verdict can take it offline.
- **Client-side secret scrub** — API keys, tokens, and credentialed URLs are redacted
  before anything leaves the machine (the server re-scrubs too).
- **Global + per-project memory** — personal preferences stay global; project facts
  scope to the repo.
- Usage **rule** and a memory-curation **skill**.
