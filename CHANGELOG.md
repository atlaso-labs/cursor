# Changelog

All notable changes to the Atlaso Memory plugin for Cursor.

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
