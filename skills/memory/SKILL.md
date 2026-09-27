---
name: memory
description: >-
  What's worth keeping in Atlaso long-term memory, and whether a fact is personal
  vs project-specific. Use when deciding if something is durable enough to remember,
  when a decision changes, or when the user asks you to remember, recall, or forget
  something.
---

# Using Atlaso memory well

Memory in Cursor is mostly **automatic** (see the Atlaso rule for the mechanics):
recall arrives at session start, and capture runs when a turn ends. Your job is
judgment: keeping the signal clear so auto-capture grabs the right thing, and using
the deliberate `Atlaso` tools when they genuinely help. Reach for `remember`
sparingly, for things that will still matter next week.

## The deliberate tools

The `Atlaso` MCP server backs the automatic loop with five tools for when you want
to act on purpose:

- `recall <query>`: pull relevant past memory before answering (read-only).
- `remember <text>`: save a durable fact or a changed decision.
- `forget <id>`: Removes it from your memory everywhere Atlaso recalls or exports it.
  You can't undo it. Ids come from `recall` or `recent`; only when asked.
- `recent`: list the latest memories.
- `status`: connected? how many memories, and the memory-health score.

Scope is inferred from phrasing, so say "for this project" or "in every project"
when it matters.

<!-- atlaso:shared-judgment begin. Generated from tools/skill-shared/JUDGMENT.md; edit that file, then run sync_skills.py. -->

## What's worth remembering (default: don't)

Save **durable** things:
- decisions **and the reason** behind them
- the user's stable preferences and working style
- hard-won gotchas ("X silently fails unless Y")
- stable facts and commands (ports, endpoints, conventions)

Don't save: transient state ("ran the tests just now"), secrets or tokens,
restatements of files or documents the user already has, or anything that only
matters in this turn.

**Never re-save something you only read from memory.** If a fact came from the
Atlaso block or from `recall`, it is already stored. Saving it again adds nothing,
and a fresh copy of an old fact can look newer than the decision that replaced it.
Save only what the user said or decided in this session.

## Personal vs project

Atlaso keeps two memories. Route deliberately:
- **Personal** (follows the user across every project and tool): cross-project
  preferences, identity, working style. "True in every project."
- **Project** (this project only): architecture, project-specific decisions and
  gotchas. "True only here."

Rule of thumb: *would this still be true in a different project?* Yes: personal.
No: project.

## When a decision changes

A changed decision is not a wrong memory. Keep the history and make the change
explicit:
- Save the new decision as a change, naming **both values and the reason**:
  "State management in the mobile app moved from Zustand to Jotai because of
  re-render cost."
- Don't `forget` the old note. It is still true that it was the choice before, and
  the change note makes clear which one is current.
- If the user goes **back** to an earlier choice, say so the same way: "Switching
  back from Jotai to Zustand for the mobile app." Don't repeat the old sentence
  word for word.
- A change that applies to only one part ("for the worker service only, keep 2
  approvals") should say its scope, so it doesn't read as a change everywhere.

## When a memory is wrong

If a memory was never true (a mistake, a misheard value, something the user says
is wrong): `recall` to find its id, then `forget` it, and save the correct fact if
there is one.
`forget`: Removes it from your memory everywhere Atlaso recalls or exports it.
Use `forget` only for a wrong memory or when the user asks you to
delete one. You can't undo it.

## Reading memories that disagree

Recalled notes can carry the UTC calendar day Atlaso recorded for the user's
statement: a date on each line of the Atlaso block, and `stated_on` in `recall`
and `recent` results. Dates only settle
notes about the same thing in the same scope; a project note and a personal note,
or notes about two different parts of a project, can both be true. When two such
notes disagree, the one the user stated most recently is current and the older one
is history, not an instruction. A note that says "moved from A to B" means B is
current. A note without a date is not newer than a dated one. If neither note is
clearly newer (no dates, or the same day), ask the user instead of guessing.

## When to deliberately `recall`

Search explicitly when:
- the user refers to a past decision ("what did we decide about X?"),
- you are about to do something that might contradict an earlier choice, or
- you are starting unfamiliar work where prior context would clearly help.

One specific `recall` beats several speculative ones. Where memories are injected
automatically, trust the injected block the rest of the time.

## Good vs skip

- Save: "Use pnpm, never npm. The user's standard across all projects." *(personal)*
- Save: "Brain server runs on port 8800; recall is `GET /v1/recall`." *(project)*
- Save: "Tauri signing key must be single-line in CI or it errors." *(gotcha)*
- Save: "Mobile app state moved from Zustand to Jotai because of re-render cost."
  *(a change, both values and the reason)*
- Skip: "Compiled the app and the tests passed." *(ephemeral)*
- Skip: re-saving "we use pnpm" because it appeared in the Atlaso block or in
  `recall`. *(already stored)*

<!-- atlaso:shared-judgment end -->
