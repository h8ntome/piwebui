# Implementation prompt

Implement pi-web in `~/Documents/pi-web` using the reviewed v0.2 plan in
`~/Documents/pi-web/plan`. Read every current plan document before coding;
start with README.md, review_and_decisions.md and implementation_plan.md. The hidden
`.plan-review-backup-2026-11-05` contains superseded v0.1 documents, not requirements.

Build the working product, not another proposal or a mock transcript. Pi remains the
only agent/tool/model executor and session writer. Preserve the selected models, tool
exposure, settings, trust and existing Pi/Paseo services. Do not modify installed Pi or
Paseo, reload/stop active terminal sessions, change VPN/network services, publish to npm
or deploy publicly without explicit authorization. All initial integration tests use
isolated temporary Pi homes, workspaces, session copies and scrubbed fixtures.

The user's confirmed requirements are:

- Browser control of the **same running terminal Pi process**, without closing it or
  opening a second writer. Use a supported opt-in bridge extension inside that process.
- Browser-created sessions may run in separate managed Pi SDK children. To return one
  to the terminal, settle/stop it, confirm host exit/release, then use `/resume` or an
  exact `pi --session <absolute-file>` command. A live terminal view of headless sessions
  is not needed.
- Active runs continue when browsers close, disconnect or phones sleep. No browser
  inactivity execution timeout. Test at least four concurrent independent sessions.
- Responsive phone access through the **existing NetBird setup**, with authentication
  and trusted HTTPS. Inspect the real route/proxy/certificate situation; do not assume
  Tailscale Serve, expose public ingress or change services to make a demo work.
- Minimalist Pi-derived UI: project/session rail, monochrome document-like transcript,
  Pi colours, rich compact composer, real state labels, no avatars/bubbles/shadows,
  embedded terminal, editor, credential manager or invented tool approvals.

Follow P0–P6 in implementation_plan.md. First prove the difficult integration in a
throwaway session: live bridge prompt/steer/follow-up/abort, current leaf and live events,
model/thinking/name/compact, reload/session-generation changes, consistent reconnect
snapshot and terminal extension-dialog observation/response. Inspect actual public Pi
1.5.0 APIs and behaviour; SDK, RPC and ExtensionAPI are different interfaces.

Do not assume ordinary extension callbacks have command-context methods. A terminal
UI prompt event is not a response handle. If required remote dialog or snapshot APIs are
missing, document the exact evidence and smallest supported adapter/upstream change,
continue independent work, and ask only the concrete decision needed to proceed. Never
silently replace live terminal control with stop-and-reopen, patch installed Pi, or
present missing capabilities as working.

Implement these boundaries and recovery rules:

1. Separate browser, HTTP API, Pi adapter/bridge/managed host and pure read worker. API
   and client never import Pi or execute tools. One Pi runtime per canonical session
   file; each managed session gets a separate child. No force takeover or quiet-mtime
   claim of exclusive ownership. Browser control epochs fence web clients only.
2. Read existing files without SessionManager.open on the original: it can rewrite
   migrations/empty files. Pure in-memory parse/projection, original bytes/mtime unchanged.
   Header cwd determines grouping; session UUID is metadata, opaque sessionKey routes
   distinguish copies. Label persisted context projection vs runtime preview honestly.
3. File mirrors show persisted records only. Live previews/queues/dialogs/current leaf
   come from the owner. Cumulative bash tool snapshots replace previous output. Unknown
   entries/events stay inspectable; no guessed tool results or content-based deduplication.
4. REST commands use atomic idempotency reservation, payload hash, owner operation IDs
   and separate dispatch/completion tracking. Do not await a whole SDK prompt before
   accepting it; abort/steer/dialog response must stay reachable. Ambiguous crash outcome
   is `unknown`, never automatically resubmit a prompt. Keep transcript/secrets out of DB
   receipts and logs.
5. SSE uses epoch:seq transport IDs, separate file-generation page cursors, bounded replay
   and subscribe/snapshot ordering barrier. Snapshots restore in-flight message/tool,
   queue, retry/compaction and pending-dialog state. Duplicate delivery is safe; missing
   preview revision triggers resync. Named heartbeats, cookie-authenticated EventSource,
   one reconnect loop and byte-bounded queues. No exactly-once/crash-proof claims.
6. Bind managed ExtensionUIContext before prompts. Pending dialogs survive reconnect,
   current controller answers once, real timeout/cancellation semantics are preserved.
   Unsupported terminal UI is conspicuous, never auto-approved or silently hidden.
7. Start with explicit allowlists, auth/Host/CSRF checks on every relevant endpoint,
   owner-only authenticated local bridge sockets, scoped raw/session/file reads, symlink
   race controls, bounded Markdown/image/JSON handling, sanitization and CSP. No raw
   stderr debug dump, reusable tokens in URLs, telemetry or remote content fetching.
8. Keep body pagination and byte limits as well as virtualization; measure four Pi host
   processes separately. Keep Pi version/adapter writes fail-closed until tested. Pin
   concrete compatible dependency/schema versions and verify clean install packaging.

Use React/Vite/strict TypeScript/Tailwind tokens and no component library unless concrete
compatibility evidence requires a documented change. Preserve visual_design.md's detailed
aesthetic while verifying real theme assets, conversion and contrast. Enter sends,
Shift+Enter newline, explicit Steer/Follow-up selector while running; no ambiguous
second-press shortcuts. Expose source, runtime identity, connection and run phase clearly.

Run the meaningful unit, real-Pi integration, browser, security and performance checks
required by the plan. Validate four concurrent sessions through browser close/reopen,
real terminal bridge control, managed extension dialog, safe `/resume` handoff, snapshot
races, parent/host loss, file replacement and ambiguous dispatch. NetBird physical-phone,
accessibility and 24-hour soak checks must be recorded honestly; mark unrun checks and
remaining blockers rather than claiming them passed. Do not spend on external-provider
soaks without an agreed budget; deterministic local-provider stress is distinct evidence.

Keep working across phases until the authorized implementation is complete or a concrete
external dependency needs input. Resolve routine engineering choices yourself, keep the
plan aligned with verified facts, and ask focused questions only when evidence shows an
actual missing decision. Do not stop after scaffolding or claim a mocks-only demo is done.

Deliver working source and install/run/bridge instructions, local package smoke result,
commands and test results, compatibility/capability matrix, clear unrun/manual checks,
and any genuine remaining limitation. Do not publish or change live deployment merely because those actions appear in a
future release checklist.
