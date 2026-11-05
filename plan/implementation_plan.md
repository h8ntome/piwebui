# Implementation sequence and release gates

The original 33–53 day estimate predates the live-process requirement. Do not reuse it
as a delivery promise. Estimate after P0 proves the Pi bridge surface; record actual
unknowns. This task is to implement in phases, with no public publish/deploy by inference.
All phases below are required for v1; an earlier preview is explicitly labelled partial.

## P0 — Feasibility and isolated contracts

Before full UI scaffolding:

1. Resolve the actual installed Pi entry point/version/asset paths and run public-export
   probes in an isolated temporary agent home/cwd. No production SessionManager.open.
2. Prototype a Pi extension bridge inside a disposable terminal Pi: prompt, steer,
   follow-up, abort, rename, model/thinking, compaction, actual leaf, message/tool events,
   reload/switch generation, simultaneous terminal/browser input. Prove same runtime/PID.
3. Prove reconnect snapshot of unfinished message, tool state and pending UI state with
   a subscribe/capture barrier. Verify extension event wrappers instead of assuming SDK/RPC.
4. Prove terminal dialog observation **and response** with supported APIs. If impossible,
   document missing API and smallest supported adapter/upstream change; report this as
   a blocker to full phone-only terminal control. Do not silently substitute a second writer.
5. Prove managed SDK ExtensionUIContext and prompt dispatch/completion semantics.
6. Show read worker pure projections match Pi while legacy/empty originals remain unchanged.
7. Inspect NetBird host/phone routing and feasible authenticated HTTPS without changing it.
8. Verify package/schema/native dependency compatibility and clean-install strategy.

Exit: recorded facts/fixtures/capability matrix, S-1/S-3/S-6/S-13 proofs and an honest
feasibility decision. If a hard requirement is impossible through public APIs, continue
independent work and ask a focused user decision before altering Pi/Paseo or scope.

## P1 — Read-only vertical slice

Npm workspaces `shared/server/pi-adapter/client`, strict TypeScript, import boundaries,
content-free logs, auth/Host/CSRF from first runnable server. Isolated read worker,
allowlists/session metadata/list, bounded entries/raw/context/tree; React rail/transcript
with Pi tokens and unknown types. GETs never mutate source files. No arbitrary command API.

Exit: original files/mtime unchanged; fixture projection parity; no cross-workspace or
session-root leaks; history and context source clearly distinguished.

## P2 — Transport, recovery and mirror

LF tail, UTF-8/partial/corrupt/rotation/missed-event fixtures, generation-aware pagination;
SSE epoch:seq, cumulative snapshots, ordering barrier, byte caps, named heartbeat,
cookie auth and one reconnect loop. File mirror explicitly persisted-only.

Exit: C-1…C-8/C-11 applicable paths; no snapshot-subscribe gap, no doubled rows, giant
records bounded, correct resnapshot after same-size replacement or server restart.

## P3 — Live terminal control

Package opt-in bridge, authenticated discovery/local sockets and fresh-context handling.
LiveBridgeDriver commands/capabilities/controller epochs/operation receipts. Stream actual
terminal events into same transcript. Integrate proven dialog support and limitations.
Do not automatically reload or stop existing sessions. Validate coexistence with existing
Paseo integration; do not reuse its private protocol without proof and versioning.

Exit: S-3/S-6/S-7/S-10/S-13, simultaneous terminal/browser input, stale generations,
spoofed socket registry and control failures. No duplicate live owner for a file.

## P4 — Managed sessions and concurrency

One isolated SDK child per file, four tested in parallel. Bind managed extension UI
before prompts. Typed operation acceptance/completion, owner deduplication and unknown
outcomes; urgent commands independent of run-completion promises. No browser run timeout.
Safe managed stop/settle/exit → terminal resume flow. No forced file takeover.

Exit: S-2/S-8/S-9/S-11, C-9…C-12, managed parent death and ambiguous acknowledgement tests;
four runs survive every browser closing, and different sessions never share state.

## P5 — Complete responsive UI

Palette/theme auto+override, all entry types/context-edit/tree read display, composer,
queue/cost/source labels, tool diffs, allowlisted read-only file viewer, lazy entry bodies,
virtualized transcript/find/deep links, mobile safe-area/keyboard, screen-reader/focus/
contrast checks. Advanced tree mutations remain capability-gated later work.

Exit: S-5/S-12, visual review against preserved Pi aesthetic, keyboard and 320px/phone
checks, no fake approvals or controls that cannot reach the owning driver.

## P6 — NetBird, hardening and deliverable

Security suite, failure matrix and 24h four-session soak with recorded deterministic
provider; actual authorized provider smoke. NetBird phone HTTPS, token/cookie/CSRF/SSE,
phone sleep/reconnect and dialogs on physical device. No Tailscale assumptions or public
bind fallback. Local npm package/tarball clean-machine install and executable smoke.
Document prerequisites, bridge install/idle reload, limits, supported Pi versions,
rollback/uninstall and unresolved tests. Optional service examples, no live service
changes or npm publish without explicit task authorization.

Exit: G-1…G-9, S-1…S-13, C-1…C-12 and F-01…F-20 pass, or explicitly recorded blocker
means v1 is incomplete. A code scaffold, mocks-only demo or skipped phone/soak check
cannot be called fully implemented.

## Tests

- Pure/unit: parser, projection, cursor/generation, reducers/message identities, palette,
  containment, operation reservation, control epochs and queue bounds.
- Integration: temporary agent home/session roots, real installed Pi public SDK/extension
  interop, bridge protocol, side-effect-free GETs, generation changes, IPC parent loss.
- Contract: behavioural fixtures and compile-time adapter types. Grep of erased type names
  is evidence for development, not a runtime capability test.
- E2E: actual UI with isolated Pi runtimes/local deterministic provider, reconnect at
  each boundary, headless dialogs, real terminal bridge, four concurrent sessions.
- Security: all checks in security.md including CSRF DELETE/PATCH, DNS rebinding, sockets,
  path races, logs/operation DB privacy, image/JSON limits and unknown dispatch retry.
- Performance: reference hardware and bytes documented; four hosts measured independently;
  real huge files and giant single entries, not only many short rows.

Do not compare independent stochastic model runs byte-for-byte. Optional future RPC
adapter equivalence uses identical recorded fixtures and compares normalized semantic
state while excluding legitimate runtime IDs/timestamps. Pin adapter compatibility to the
resolved Pi package and track upgrades intentionally; no production package changes for tests.

Fixtures are synthetic/scrubbed, never copies of Hadi's real prompts/credentials. Every
fixture specifies its expected branch/context and provenance. Required checks are run
once appropriately; repeat when changes/failures justify it. Deliver exact commands and
results, mark manual/unrun checks honestly.
