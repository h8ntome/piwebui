# Architecture

## Processes and ownership

```text
React browser ── HTTPS REST + SSE ── API server
                                      ├─ read worker: pure Pi parse/projection helpers
                                      ├─ private metadata/operations/control grants
                                      ├─ LiveBridgeDriver ─ local socket ─ terminal Pi + bridge
                                      └─ SdkHostDriver ─ child IPC ─ managed Pi SDK runtime
Pi runtimes ── Pi SessionManager ── session JSONL files
API server ── read-only file watcher ── session JSONL files
```

Exactly one live Pi runtime owns a given session file. Multiple distinct files can
have concurrent owners. The API server never imports Pi, calls a tool or directly edits
a session. Pi imports are restricted to `packages/pi-adapter`, used by isolated read
workers, managed hosts and the Pi extension bridge. Shared/client types are our wire
schemas, not leaked Pi internal objects.

## LiveBridgeDriver: terminal sessions

Ship a separately installable Pi extension that runs **inside** the terminal Pi process.
It advertises an authenticated Unix-domain endpoint in an owner-only directory. The
registry includes random runtime ID, process start identity, canonical session path,
session ID, cwd, protocol version, Pi version and capability set. Registry entries are
hints; handshake, peer identity, process start and session binding must be validated.
No network listener is opened by the extension.

Bridge commands call supported `ExtensionAPI`/current `ExtensionContext` operations in
that runtime. `sendUserMessage` accepts delivery mode, model/thinking/name setters exist,
and `ctx.abort()`/`ctx.compact()` exist. The public extension API differs from RPC and
SDK: do not implement one by pretending its method names/signatures are the other's.

Context objects become stale after reload/session replacement. Rebind on session events,
invalidate old control grants and operation targets, and remove only registry/socket
artifacts owned by the matching runtime generation. Session switching changes identity.

The bridge emits live message/tool lifecycle, model/thinking, branch and settled state,
and maintains a bounded cumulative preview for reconnect. Capability reporting must
separate snapshot reads, prompt delivery, queue introspection, queue clearing, commands,
branching and dialog response. Unsupported methods return `501`; never simulate them.

P0 must prove actual supported routes for terminal dialogs and the selected live event
payloads. A passive UI prompt notification does not prove a browser can answer it.
Do not monkey-patch captured contexts or install changes to Pi/Paseo as a hidden workaround.

Existing terminal processes must load the bridge at an idle `/reload` or next start.
Processes without it remain persisted-file mirrors. Never interrupt them to install it.

## SdkHostDriver: browser-created sessions

Create one child per managed session, initially max four. Each embeds Pi with the public
SDK and authenticates its IPC. The same user's existing model/auth/settings/trust are
inherited explicitly; do not invent defaults that silently change model or tool exposure.
Bind `ExtensionUIContext` before accepting prompts. Implement select/confirm/input/editor
requests, cancellation, request timeouts and exactly one valid response from the current
controller. Unknown custom TUI-only UI is reported as unsupported, never auto-approved.

SDK `prompt()` returns a run-completion promise, not the RPC acceptance envelope.
Create an operation, start the SDK call without blocking the acceptance response, handle
its rejection, and track authoritative completion/settled state separately. Do not report
accepted before the host has actually acknowledged dispatch. Host failure during dispatch
can leave an operation `unknown`; see reliability.

## Read worker

Cold read uses streaming LF JSONL parsing and immutable entry arrays with exported pure
`parseSessionEntries`/migration/projection helpers where their semantics are proven.
Migration is in memory/on copies only. Never call `SessionManager.open()` on an original
file to satisfy a GET: Pi can rewrite old/empty files while opening them.
Do not load project extensions, trust prompts or credentials in the read worker.

Read metadata from the session header, not from a lossy encoded directory name. Enforce
configured session roots and workspace policy before returning summaries or contents.
Historical stats/context are explicitly labelled with source and availability; runtime
stats are sourced from the live owner when supported.

## API server and client

Node >=22.19.0, Fastify, React, Vite, strict TypeScript, Tailwind, Zustand, marked plus
DOMPurify, lazy syntax highlighting. Pin concrete tested versions in the lockfile.
Confirm the selected TypeBox package and Fastify adapter interoperate: Pi's `typebox`
package name is not automatically interchangeable with `@sinclair/typebox` integrations.
Use `better-sqlite3` only after clean-machine packaging is verified; do not assume native
builds and install-size budgets disappear. No runtime deep imports from Pi `dist`.
Pi theme JSON may be read through versioned asset discovery; missing assets use a bundled,
licensed tested palette with a warning.

Private DB stores allowlists, UI prefs, controller epochs and operation receipts only.
No transcript or live-token log is persisted by pi-web. Transient reconnect caches are
bounded and rebuilt from the runtime or file. Drafts are opt-in browser-only UI data.

## Internal IPC

Managed children use `child_process.fork` with an actual `ipc` channel and separate stderr.
Use IPC for commands and events in v1; no NDJSON stdout channel configured as `ignore`.
Extensions may print stdout; it is not protocol input. Socket framing is LF-only JSON,
with length/depth caps, typed envelopes and per-runtime request IDs.

Commands that change configuration/session serialize through a runtime actor. An active
prompt does not block urgent abort, steering, follow-up or dialog responses behind its
completion promise. Snapshot capture and event delivery share an ordering barrier.

## Deployment

Default `127.0.0.1:4319`; port override; auth required even locally. For NetBird phone
access prefer an authenticated HTTPS reverse proxy to loopback over the actual reachable
NetBird address/DNS. Do not assume NetBird provides Tailscale Serve, identity headers or
certificates. Verify current host/phone routing, trusted TLS, firewall and sleep behaviour.
No public internet ingress or all-interface bind by default. SSH forwards retain auth.
No automatic network/VPN/service reconfiguration as part of code scaffolding.

## Layout

```text
packages/shared       schemas, own wire types
packages/server       HTTP, auth, SSE, file tail, private store, supervision
packages/pi-adapter   read worker, bridge extension, SDK host, capability checks
packages/client       rail/transcript/composer/panels/theme
fixtures              synthetic scrubbed sessions; expected projections
scripts               contract checks, palettes, launch/package verification
e2e                   isolated real-Pi interop and browser tests
```

Unknown Pi versions disable write drivers until adapter tests pass. Runtime feature probes
check actual supported methods/behaviour; erased TypeScript declarations are not runtime
capability discovery. Never spawn a live writer merely to probe a real session.
