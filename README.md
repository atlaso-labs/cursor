# Atlaso × Cursor

The Cursor connector for Atlaso memory, packaged as **one bun-native Cursor
plugin**. Lives under `platform/tools/<tool>/` — one folder per tool.

It's deliberately thin: the hooks call the brain's REST API directly and the
engine stays on the server (the IP thin-client rule, in TypeScript). **No uv, no
Python, no vendored runtime, no build step** — Cursor ships bun, and a plugin is
just files.

## One plugin, three surfaces (today)

Cursor (2.5+) has a real plugin format + Marketplace. `.cursor-plugin/plugin.json`
declares the surfaces; Cursor loads them and substitutes `${CURSOR_PLUGIN_ROOT}`
(the installed path) into hook commands.

| Surface | Declared | What it does | Status |
|---|---|---|---|
| **Hooks** (the auto-loop) | `hooks: ./hooks/hooks.json` | `sessionStart → recall.ts` (recall returned as session context); `stop` + `sessionEnd → capture.ts` (capture the exchange). Capture needs no model involvement; recall reaches the chat only if Cursor delivers the hook's context (see below). **This is the point.** | **Built + tested** (hook output; native IDE delivery not verified) |
| **Rule** | `rules: ./rules/` | `atlaso-memory.mdc` (`alwaysApply`) orients the model: memory is automatic; treat recall as known context. | **Built** |
| **Skill** | `skills: ./skills/` | `memory/SKILL.md` — curation judgment (what's worth keeping, personal vs project). | **Built** |
| **MCP server** | `mcp: ./mcp.json` | `Atlaso` server (`lib/mcp.ts`, inline bun stdio) exposes `recall/remember/forget/recent/status` for deliberate moves. Reuses the SAME per-tool credential the hooks mint — one auth, one unlink. | **Built + tested** |

The **hooks are the point**: capture runs with no model involvement, and recall is
returned as session context when each session starts. If Cursor drops that context,
recall depends on the agent calling the `recall` tool (see below). The **MCP server**
adds deliberate control (ask the agent to remember/recall/forget on demand).

## Why bun

Cursor provides **bun** to plugins — its own first-party `continual-learning`
memory plugin runs `bun run …ts` with no `package.json` and no `node_modules`. So a
bun/TS connector has **zero runtime dependency** on Cursor, strictly better than
shipping a Python/uv runtime. The hook code imports only `node:*` built-ins + the
global `fetch`, so it runs on bun in Cursor and on node for local tests.

## How the loop works (honest notes)

### Recall is delivered as session context; nothing is saved in the workspace
`recall.ts` runs at `sessionStart` and returns the recalled notes as the hook's
`additional_context` (at most 9,000 characters; whole notes are dropped from the end
beyond that). It writes nothing into your workspace. Newly recalled notes are returned
as session context; if an older `.cursor/rules/atlaso-recall.mdc` remains, delete it
with write access before copying or staging this folder.

Earlier versions wrote the notes into `.cursor/rules/atlaso-recall.mdc`. That is not
safe in every case: a repository's `.git/info/exclude` does not travel when the folder is
copied, and the Cursor IDE has been reported to skip rules files that Git ignores. At the
start of the first chat after the update, the plugin removes the old private rules file
first, before contacting Atlaso; in a read-only folder it cannot, and the file stays until
you delete it with write access. The files it removes are Atlaso's own old files in
`.cursor/rules` (`atlaso-recall.mdc`, `atlaso-notice.mdc` and Atlaso temp files; a file
of the same name that does not start with Atlaso's header is kept). If `.cursor` or
`.cursor/rules` is a symbolic link, Atlaso follows it only when it resolves to a folder
inside the workspace, where a `git add -A` could commit the old file, and deletes the old
file there. When the link leads outside the workspace, Atlaso deletes nothing there; the
chat's recalled block names the file and gives the command,
`rm .cursor/rules/atlaso-recall.mdc`.

The Cursor IDE can drop sessionStart `additional_context` (a staff-acknowledged timing
bug). If Cursor drops the Atlaso Memory block, recall depends on the agent calling the `recall` tool when past context helps; automatic recall for that IDE path has not been verified. The plugin's own rule, shipped inside the plugin rather than your
workspace, tells the agent to call `recall` when the chat has no Atlaso Memory block and
past context would help. With `ATLASO_DEBUG=1` the debug log shows
`delivery=context chars=<n>` when the hook returns context; that shows the hook's output,
not what the IDE displayed.

### Capture is automatic + scrubbed
`stop` / `sessionEnd` pull the exchange from the documented payload fields
(`afterAgentResponse.text` / `beforeSubmitPrompt.prompt`) or, as a fallback, the
`transcript_path` file (parsed defensively — its on-disk format is undocumented).
A commodity worth-keeping gate skips chatter; **secrets are scrubbed client-side**
before anything leaves the machine (the server re-scrubs too). Scope (personal vs
project) + a project key are inferred and tagged, preserving the dual-memory model.

### First-run authorize
On the first session with no `~/.atlaso/auth.json`, `recall.ts` kicks a detached
browser-authorize flow (`hooks/connect.ts`, an RFC-8628 device flow) that writes
the **shared** auth.json every connector uses. One device token → the whole plugin
is one device (fits the free 1-device cap).

### Cloud agents
Cursor cloud / background agents don't run `sessionStart` / `stop` / `sessionEnd`,
so there's no automatic loop there — interactive desktop Cursor gets the full loop.

## v1 scope (online-first)
**Per-tool credentials landed** — the plugin mints and holds its OWN token at
`~/.atlaso/tools/cursor.json` (a kernel-locked exchange from the shared bearer;
`lib/credential.ts` + `lib/lock.ts`), so "remove Cursor" revokes only Cursor and a
verified server verdict is the ONLY thing that can take it offline (never-brick).
Still deferred (flagged, not hidden) vs the Python thin client: the **offline cache
+ outbox/sync**. v1 talks to the brain directly; with no token it simply no-ops
(memory never breaks a turn). The brain enforces the device + tool caps at authorize.

## Install

### Atlaso CLI (the live path)
```bash
curl -fsSL https://atlaso.ai/install.sh | bash
atlaso setup   # → choose Cursor
```
Cursor has no in-app install verb, so the CLI **file-drops** the plugin into
`~/.cursor/plugins/local/atlaso` (it embeds the bundle at build time). Then fully
restart Cursor to start the hooks. This is the primary channel for anyone who
already knows Atlaso.

### Marketplace (discovery — once published)
```
/add-plugin atlaso
```
The goal: a verified, reviewed Marketplace listing for people who DON'T yet know
Atlaso. **Not live yet** — needs the `atlaso-labs/cursor` repo + listing (see the
deploy checklist, `project_atlaso_go_live_deploy_checklist.md` §7).

### Local (dev / testing today)
A plugin is just files — no build step. Copy it into Cursor's local-plugins dir:
```bash
cd platform/tools/cursor
./install.sh            # → ~/.cursor/plugins/local/atlaso
```
Restart Cursor (or reload the window). Requires `bun` on PATH (Cursor provides it).
Uninstall: `rm -rf ~/.cursor/plugins/local/atlaso`.

## Layout
```
tools/cursor/
  .cursor-plugin/plugin.json   the manifest (declares hooks + mcp + rule + skill)
  mcp.json                     declares the `Atlaso` MCP server (bun run lib/mcp.ts)
  hooks/hooks.json             sessionStart→recall.ts, beforeSubmitPrompt/afterAgentResponse/stop/sessionEnd→capture.ts
  hooks/recall.ts              sessionStart: autoconnect + recall → additional_context
  hooks/capture.ts             per-turn stash (before/after) + stop/sessionEnd deposit
  hooks/connect.ts             runnable device-authorize entrypoint (spawned detached)
  lib/mcp.ts                   inline zero-dep bun MCP stdio server (5 memory tools)
  lib/atlaso.ts                thin brain client (auth + fetch, fail-open; per-tool files)
  lib/credential.ts            per-tool credential state machine (mint under lock; never-brick)
  lib/lock.ts                  bun:ffi flock kernel lock (one-owner-one-lock)
  lib/pending.ts               per-turn capture stash (<atlaso_dir>/cursor-pending)
  lib/capture.ts               commodity gate + secret scrub + scope/polarity
  lib/transcript.ts            payload + transcript-file exchange extraction
  lib/render.ts                recalled-memory .mdc rendering + sanitization
  lib/project.ts               per-project key (git origin / root hash)
  lib/connect.ts               device-authorize flow + autoconnect + lock
  lib/stdin.ts · lib/log.ts    stdin reader · opt-in debug log
  rules/atlaso-memory.mdc      static usage rule (alwaysApply)
  skills/memory/SKILL.md       curation-judgment skill
  AGENTS.md                    no-frontmatter alternative to the rule
  install.sh                   local install (copy → ~/.cursor/plugins/local)
  tests/                       bun test: heuristics · credential · lock · pending · mcp · e2e
```

## Roadmap
- **Offline cache + sync** parity with the Python thin client.
- **Cursor Marketplace listing** (`atlaso-labs/cursor`) — the discovery channel.

Done: automatic hooks loop · 5-tool `Atlaso` MCP server · per-tool credentials
(mint-under-lock, never-brick) · client-side capture gate + secret scrub.

## Dev / test
```bash
cd platform/tools/cursor
bun test
```
`ATLASO_DEBUG=1` writes per-hook logs to `<atlaso dir>/atlaso-cursor-*.log`. Env
knobs: `ATLASO_GLOBAL_PATH` (auth/dir override), `ATLASO_SERVER` (brain URL),
`ATLASO_NO_CONNECT` (skip autoconnect), `ATLASO_NO_BROWSER` (don't open a browser).
