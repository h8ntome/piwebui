# API v1

Base `/api/v1`. These are pi-web contracts to implement, not existing Pi endpoints.
Unsupported driver capabilities return `501`; future endpoints are not release promises.
All session resources use opaque server-issued `sessionKey`, not a bare Pi UUID/path.

## Authentication and errors

Bearer auth for API clients; same-origin HttpOnly cookie for browser/EventSource.
A one-use short-lived bootstrap code is exchanged on a dedicated auth endpoint, followed
by URL cleanup; never put reusable bearer tokens in stream URLs. All reads, metadata,
health and SSE require auth; only static boot assets and bootstrap exchange are exceptions.
Validate configured Host/origin allowlists independently of request-supplied Host. Cookie
mutations of **every** HTTP method require matching Origin plus CSRF header/token.
No cross-origin credentialed CORS. Strict JSON, 8 MiB encoded request ceiling.

| HTTP | code | Meaning |
|---|---|---|
| 400 | invalid_request | malformed schema/arguments |
| 401 | unauthorized | missing/invalid authentication |
| 403 | forbidden | origin, CSRF, path or allowlist policy |
| 404 | not_found | inaccessible/unknown resource |
| 409 | owner_conflict / busy / idempotency_conflict | conflicting runtime, invalid run state, or key reused for different payload |
| 410 | cursor_expired | paged read cursor invalid; SSE uses resync event instead |
| 412 | stale_control | controller epoch/session/runtime generation mismatch |
| 413 | payload_too_large | encoded request/attachment cap |
| 423 | read_only | unverified adapter or conflicted session |
| 429 | capacity | active session/stream/rate capacity |
| 501 | unsupported_capability | unavailable command for this driver |
| 502 | pi_command_failed | immediate Pi rejection before async acceptance |
| 503 | host_unavailable | runtime unavailable |
| 504 | timeout | dispatch deadline, operation may need reconciliation |

Errors: `{error:{code,message,details?,correlationId}}`. Runtime failures after acceptance
are operation/state events. `202` means acknowledged dispatch, never completed work.

## Resource surface

| Method | Route | Result/purpose |
|---|---|---|
| GET | `/health`, `/meta`, `/capabilities` | authenticated liveness, limits, tested compatibility, per-driver capabilities |
| GET/POST | `/workspaces` | list/add canonical existing allowlisted cwd; no implicit session scan permission |
| DELETE | `/workspaces/:workspaceKey` | remove allowlist; block future commands immediately; explicit active-run handling, no silent abort |
| GET | `/sessions?workspaceKey=&q=&limit=&cursor=` | metadata-only paginated list; summaries from headers, bounded reads/cache |
| POST | `/sessions` | `{workspaceKey,model?,thinkingLevel?,name?}` creates managed Pi host and pending session; reserves capacity |
| GET | `/sessions/:sessionKey` | mode, source, owner identity, current generation, capabilities, state, stats availability |
| GET | `/sessions/:sessionKey/entries?cursor=&limit=&branch=` | bounded entries + nextCursor + fileGeneration + leaf; separate from SSE cursor |
| GET | `/sessions/:sessionKey/entries/:entryId` | full one-entry details, with size limits and truncation metadata |
| GET | `/sessions/:sessionKey/tree` | read-only tree including multiple roots and owner/file leaf source |
| GET | `/sessions/:sessionKey/context` | persisted projection or runtime preview, source/leaf/capturedAt; absent dynamic fields are null/unavailable |
| GET | `/sessions/:sessionKey/stats` | owner-reported stats if available; otherwise labelled persisted totals, unknown runtime usage null |
| GET | `/sessions/:sessionKey/raw` | authorised range download from registered session root only; no arbitrary file argument |
| GET | `/sessions/:sessionKey/events?cursor=` | authenticated SSE snapshot/replay/live; does not acquire control or start Pi |
| GET/POST | `/sessions/:sessionKey/control` | inspect/acquire/renew/release browser control grant; not file ownership |
| POST | `/sessions/:sessionKey/commands` | typed command + operation ID + control grant; dispatch to bound owner |
| GET | `/operations/:operationId` | accepted/running/succeeded/failed/cancelled/unknown + safe result |
| GET | `/sessions/:sessionKey/models`, `/commands` | owner-scoped model catalogue/commands, secret-free |
| GET | `/themes/current` | validated derived palette; no extension code execution |
| GET | `/files?workspaceKey=&path=` | contained, capped text/listing; no uploads/writes |

Session trash/export and standalone git routes are deferred. If added later they require
explicit auth, ownership checks, safe download IDs and no user-selected output path.
Do not call system `trash`/git through an arbitrary-command escape hatch.

## Commands

Envelope: `{operationId, runtimeId, runtimeGeneration, sessionGeneration, controlEpoch,
controlSecret, command:{type,...}}`; `Idempotency-Key` required for all mutations, including
PATCH/DELETE if later introduced. Short bootstrap operations have separate one-use semantics.
Never expose secrets back to follower tabs or in normal snapshots.

| Type | Meaning | Capability notes |
|---|---|---|
| `prompt` | `{text,images?,delivery:"start"|"steer"|"followUp"}` | idle start; busy start rejected, never silently converted |
| `abort` | request owner abort, wait for settled state asynchronously | cannot undo tool effects |
| `compact` | Pi compaction with optional instructions | async operation; do not use short HTTP completion deadline |
| `setModel` | `{provider,modelId}` | Pi performs auth/model validation; preserve selected provider/model |
| `setThinking` | `{level}` | read back actual clamped level |
| `rename` | `{name}` | through Pi setter only |
| `clearQueue` | return removed text | advertise only if owning driver supports it |
| `dialogResponse` | `{requestId,requestGeneration,value?,cancelled?}` | validate request, current grant, timeout and exactly-one answer |
| `stopForTerminal` | wait/explicit abort → settle → dispose managed host → exact command | managed only; never release mid-run |

Interactive branch/fork/switch/retry toggles remain capability-gated future work; the
ordinary terminal `ExtensionContext` does not grant command-context methods. Pi slash
commands are dispatched only through a verified Pi command/template input path. Browser
must not fake built-in TUI commands or assume inserting `@path` in text invokes CLI
attachment preprocessing. Ordinary user text is passed faithfully; file attachment
semantics require an explicit tested adapter.

For SDK, do not await the full `prompt()` run before `202`. For extension bridge,
`sendUserMessage()` is void: bridge acknowledges actual invocation, then observes lifecycle;
it must not fabricate RPC `disposition`. Return our own `{operationId,status:"accepted"}`.

## Idempotency and operation state

Reserve `(authenticatedPrincipal,sessionKey,runtimeGeneration,key)` transactionally before
dispatch; store a canonical payload hash, command kind, dispatch state and safe receipt.
Parallel requests share one reservation; different payload same key →409. Store no prompt
body. The owner deduplicates operation IDs before invocation as well. Never replay
credentials/control secrets to a different controller just because it knows a key.

Acknowledgement loss after invocation is ambiguous. Recover by querying the same runtime
operation receipt; after owner death mark unknown and ask user to inspect persisted
history. Never silently resubmit a prompt/tool-producing command. This is deduplicated
delivery within a known owner generation, **not exactly-once execution across crashes**.
Receipts retained 24 h after terminal state; active/unknown operations do not expire merely
because a request deadline elapsed. Keep opaque tombstones for retired operation IDs.

## SSE and recovery

Wire envelope: `{name,source,runtimeId?,runtimeGeneration?,sessionGeneration,streamEpoch,
seq,entryId?,liveMessageId?,payload}`. `entryId` is present only for actual persisted
entries. Assign a distinct `liveMessageId` before streaming, later reconcile to entry ID
through verified owner mapping; do not deduplicate by text/timestamp guesses.

SSE `id` is only `<streamEpoch>:<seq>`, a server transport position. Never alternate Pi
entry IDs and transient counters. `Last-Event-ID` or query `cursor` resumes only this
bounded in-memory transport log. Epoch mismatch, eviction, file generation change or
preview loss → explicit `resync` followed by full bounded snapshot and live subscription.
Persisted entry pagination uses a different opaque cursor containing file generation and
record position. Neither short Pi IDs nor seq counters encode durable runtime state.

Connect algorithm: register subscriber behind per-session barrier → capture persisted
high-water position plus owner runtime state/cumulative in-flight messages, tools, queues,
retry/compaction state, pending dialogs and actual leaf → send snapshot tagged with barrier
sequence → drain strictly later buffered events → live. If owner snapshot cannot be captured
consistently, retry snapshot; never fill a gap with incomplete deltas. Page large histories
against the snapshot generation and watermark, invalidating on replacement.

Delivery is at least once; reducer is idempotent. Durable files permit eventual history
recovery, not replay of every token. Stream retention may reset after server restart.
For unbridged mirror snapshots, runtime fields are unavailable, not assumed idle.

Named events include `snapshot`, `entry`, `preview`, `runtimeState`, `toolState`,
`queueState`, `dialogRequest`, `dialogResolved`, `operationState`, `controlState`,
`ownerChanged`, `conflict`, `resync`, `heartbeat`, `hostExited`, `streamEnd`, `unknown`.
Pi payloads are retained inside these versioned envelopes; extensions/RPC/SDK have
explicit normalizers rather than a false shared raw event shape.

SSE headers: text/event-stream, no-store/no-transform, X-Accel-Buffering:no. Named
`heartbeat` data every 15 s so JS can observe it; comments alone do not reset a JS watchdog.
45 s without a data event → close/recreate EventSource. Cookies authenticate native
EventSource; it cannot set a custom bearer header. App-managed retries close the old
source before applying jitter/backoff, preventing duplicate reconnect loops. Native
EventSource cannot expose custom response headers/status bodies to ordinary JS; use
`resync`/snapshot events and an authenticated status fetch when needed.

Standards: [WHATWG SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html).
