# Vision and scope

## Product

A minimalist browser window into Pi sessions, with control routed to the Pi process
that owns each live session. Terminal and browser input reach one runtime and one
conversation tree. Browser-created sessions can later resume in the CLI after a clean stop.

A session file alone is neither a live control channel nor a complete runtime snapshot.
File mirror mode shows **persisted** history only; live tokens, pending dialogs, queues
and an unpersisted branch selection require the owning runtime's bridge.

## Execution boundary

Pi performs model requests, tools, extension execution, compaction and session writes.
pi-web may read allowlisted session/workspace files, serve HTTP, maintain private UI
metadata, launch a configured Pi host executable and manage its lifecycle. Optional git
status/diff is a narrowly defined read adapter, with fixed arguments, no shell and no
arbitrary command endpoint. It must not run model/tool requests itself.

Private UI preferences and drafts are allowed; they must be labelled as UI state.
A child process isolates crashes, not filesystem privileges. The browser can request
real extension confirmations; it cannot invent a tool approval boundary Pi lacks.

## User-confirmed scope (2026-11-05)

- Live control of terminal-started Pi without closing that Pi process.
- Browser-created sessions may stop and resume using `/resume`; no live terminal view
  of a headless SDK runtime is required.
- Browser absence never stops an active run. Host death, machine sleep and provider
  failure remain real limits and must be displayed honestly.
- Several sessions concurrently, initially four tested independent runtimes.
- Phone access over existing NetBird networking, authenticated and HTTPS protected.

## v1 must ship

Session rail grouped by header `cwd`; explicit allowlists; read-only cold open; persisted
file mirror; terminal bridge discovery and core live control; browser-created managed
sessions; prompt/steer/follow-up/abort; model/thinking controls where supported; rename;
compaction; real run/queue state; extension-dialog support for managed sessions; honest
terminal-dialog handling; reconnect without duplicate rows; safe stop-and-resume; four
concurrent sessions; dark/light/auto themes; responsive phone layout; read-only file
viewer and Pi tool-result diffs; security and packaging gates.

Terminal extension dialog response through the bridge is an early feasibility gate.
If public Pi APIs cannot provide it, document the limitation and the smallest supported
adapter/upstream change. Do not ship an app that silently leaves a run waiting for an
invisible terminal dialog, and do not claim phone-only terminal supervision is complete.

## Deferred

Interactive tree navigation/fork/clone until command-context support is proven; export;
standalone git status/diff if fixed read operations are not implemented safely; Windows
certification; PWA/push; multiple hosts aggregated into one UI; RPC fallback driver;
editing project/config files; provider login; worktree management; multi-user accounts.
Tree **rendering**, branch-relative context edits and unknown entries remain in v1.

## Acceptance goals

| ID | Pass condition |
|---|---|
| G-1 | Persisted transcript/projection agrees with Pi pure helpers for the same entries and leaf; raw source is unchanged by reads. |
| G-2 | File mirror follows complete persisted records; live bridge streams tokens before persistence. Neither is mislabelled. |
| G-3 | Browser controls the terminal owner's process; PID/runtime identity is unchanged. |
| G-4 | Managed session settles, stops, releases its file; CLI resumes the same absolute file with the last turn present. |
| G-5 | Browser/phone sleep never aborts any of four active runs; reopen restores runtime and persisted state. |
| G-6 | SSE gaps and restarts resnapshot correctly; duplicate delivery causes no duplicate transcript rows. |
| G-7 | Pi palette, no bubbles/avatars/shadows, accessible keyboard and phone controls. |
| G-8 | Unverified Pi adapter disables writes; unknown data remains inspectable. |
| G-9 | Authenticated NetBird phone use passes real reconnect, dialog and command tests. |

A context view is a **persisted projection** or **runtime preview**, not a promise of the
exact next provider request. Hooks, model routing, tools and provider conversion can
change that request after the preview.

Performance targets: local cold start <5 s excluding package download; 5,000-entry
first usable view <1.5 s on a recorded reference machine; ordinary stream paint p95
<50 ms; initial local attachment excludes provider first-token latency. Measure large
single-entry files as well as entry counts; virtualization alone does not bound memory.
