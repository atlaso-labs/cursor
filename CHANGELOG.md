# Changelog

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

## 0.2.1 (2026-09-21)
- Project-aware Ambient Memory: scoped first-session context, enrichment lineage fixes. Qualified against emergence-lab a895cf5e (core a0a461ff).
