# API Specification

pi-web API v1. Owns decisions D-04, D-09. Everything the frontend may do is in this file;
anything not listed does not exist. Base path `/api/v1`. All bodies `application/json`
(UTF-8, LF-only framing on the SSE channel).

---

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <token>` or `piweb` httpOnly cookie. Token printed once at startup. Loopback binds MAY accept `?t=` on first hit to seed the cookie ([security.md](security.md#network-exposure)) |
| Origin | Requests MUST carry a same-origin `Origin`/`Referer` when present; mismatched → `403`. Blocks DNS-rebinding against a localhost server |
| Content | Requests ≤ `8 MB` (image attachments). `Content-Type` strictly `application/json` |
| Ids | Session id = pi UUID ✓; entry id = pi's short hex id ✓; session **path** is accepted only where `path` is documented |
| Timestamps | ISO-8601 UTC (entry timestamps ✓) and Unix ms (nested message timestamps ✓) — never normalized away, both are passed through so parity with pi's files is verifiable |
| Cursor | Opaque string = a pi entry id ✓; `since` means "strictly after" ✓ |
| Idempotency | Every mutating `POST` accepts `Idempotency-Key`; server stores `(key → response)` for `10 min` and replays. Protects prompts from retry double-send |
| Versioning | `Pi-Web-Version` header echoed. Breaking changes → `/api/v2`. Additive fields are non-breaking and clients MUST ignore unknown fields |
| Errors | Only via HTTP status + body `{ error: { code, message, details? } }`. Pi-side failures are **never** HTTP errors — they arrive as events (see below) |
| CORS | `null` by default: no cross-origin access. Only `--cors-dev` during development |
| Rate limit | None locally; a global `60 rps` guard exists to catch a runaway client loop |

### Error taxonomy

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Schema validation failed (details = TypeBox errors) |
| 401 | `unauthorized` | Missing/bad token |
| 403 | `forbidden` | Origin mismatch, or path outside workspace allowlist |
| 404 | `not_found` | Session/file/entry unknown |
| 409 | `lease_conflict` | Session held by another writer or fresh external writes (`details.lastSeenEntry`, `details.suggestMirror`) |
| 409 | `diverged` | Session tree gained a foreign child; writes frozen |
| 409 | `streaming_required` | pi rejects a prompt mid-run without `streamingBehavior` ✓ |
| 410 | `cursor_expired` | `since` id not found → client must full-resync |
| 423 | `read_only` | Version probe failed → attach disabled, mirror allowed (G-8) |
| 429 | `capacity` | `maxAttached`/`maxMirrored` reached |
| 500 | `internal` | Unexpected; carries a `correlationId` for logs |
| 501 | `unsupported_capability` | Installed pi lacks the capability (details name it) |
| 502 | `pi_command_failed` | Driver returned `success:false` — the message is pi's own error string ✓ |
| 503 | `host_unavailable` | agent-host down/restarting |
| 504 | `timeout` | Command deadline exceeded |

Note `502`: pi answers a failed RPC command with `{success:false, error}` ✓ and
prompt-level failures after acceptance arrive as events, not responses ✓. The API keeps
that split honestly.

---

## Meta

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness; `{ ok, uptimeMs, version, piVersion, capabilities[], hosts:{live,stale}, counts }` |
| GET | `/meta` | Boot payload for the SPA: `{ version, piVersion, mode:"read-only"?, workspaces[], prefs, limits, capabilities }` |
| GET | `/capabilities` | Full probe report incl. `warnings[]` |

## Workspaces

| Method | Path | Notes |
|---|---|---|
| GET | `/workspaces` | Allowlisted dirs with session counts; `[{ path, exists, name, sessionCount, lastModified }]` |
| POST | `/workspaces` | `{ path }` — add; requires token; canonicalized realpath, must be an existing directory |
| DELETE | `/workspaces/:path` | Remove from allowlist (never touches files) |
| GET | `/workspaces/:path/validate` | `{ exists, isDir, trusted, projectResources[], trustRequired }` — surfaces pi's project-trust requirement ✓ before the user tries to attach |

Default allowlist policy is **Q-02** (open question). Proposed: empty by default, `pi-web
add <path>` to register; the alternative (auto-add any cwd found under the sessions dir)
is one flag away and easier day one.

## Sessions

| Method | Path | Purpose |
|---|---|---|
| GET | `/sessions` | List. Query: `cwd?`, `all?`, `named?`, `q?`, `sort=modified|created|messages`, `limit`, `cursor`. Backed by `SessionManager.list/listAll` ✓ |
| POST | `/sessions` | Create: `{ cwd, name?, model?, thinkingLevel? }` → `{ session, pending:true }` (no file until first message ✓) |
| GET | `/sessions/:id` | Summary + `{ mode, lease, stats, usage, leafId, entryCount }` |
| PATCH | `/sessions/:id` | `{ name? }` via `set_session_name` ✓ |
| DELETE | `/sessions/:id` | Trash the file (pi's own policy ✓); `409` if leased |
| GET | `/sessions/:id/entries` | Full ordered entries (excluding header ✓) + `{ leafId }`. Query `since=<entryId>` ✓, `kind?`, `limit` |
| GET | `/sessions/:id/tree` | `get_tree` shape: `[{ entry, children, label?, labelTimestamp? }]` + `leafId` ✓ — may contain multiple roots ✓ |
| GET | `/sessions/:id/context` | **The "what will the model see" endpoint:** `{ messages[], systemPrompt, tools[], tokens, contextWindow, percent, compactionApplied, firstKeptEntryId }` |
| GET | `/sessions/:id/stats` | `get_session_stats` shape ✓: counts, `tokens{input,output,cacheRead,cacheWrite,total}`, `cost`, `contextUsage` (which is `null` right after compaction ✓ — UI handles it) |
| GET | `/sessions/:id/raw` | Byte-range access to the `.jsonl` for download/inspect; `text/plain`, never pretty-printed |
| POST | `/sessions/:id/export` | `export_html` ✓ → `{ path }` (server-side file; returned as a download link) |

## Lease

| Method | Path | Body → Response |
|---|---|---|
| GET | `/sessions/:id/lease` | → `{ mode, token?, expiresAt, holder:"self"|"other"|"external", externalSignal }` |
| POST | `/sessions/:id/lease` | `{ mode:"mirror"|"attach"|"release", token, force?, client }` → `{ mode, token, expiresAt }`; `409 lease_conflict` per [session_management.md](session_management.md#takeover-and-conflict) |
| PATCH | `/sessions/:id/lease` | renew → `{ expiresAt }`; `412` if token fenced out; client then reloads mode |

## Command semantics

All `POST /sessions/:id/<verb>`; all honour `Idempotency-Key`; all `202` where work
continues asynchronously.

| Path | Body | Maps to pi ✓ | Response `data` |
|---|---|---|---|
| `/messages` | `{ text, mode?, images? }` `mode`∈`replace,steer,followUp` | `prompt` (streamingBehaviour only when streaming ✓) | `{ disposition:"started"\|"queued"\|"handled" }` ✓ |
| `/messages/steer` | `{ text, images? }` | `steer` | `{ disposition:"queued"\|"handled" }` ✓ |
| `/messages/follow-up` | `{ text, images? }` | `follow_up` ✓ | as above |
| `/messages/clear-queue` | — | `clear_queue` ✓ | `{ steering[], followUp[] }` ✓ (client restores text into editor) |
| `/abort` | — | `abort` (waits idle ✓) | `{}` |
| `/compact` | `{ instructions? }` | `compact` ✓ | `{ summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, usage }` ✓ |
| `/model` | `{ provider, modelId }` | `set_model` ✓ | `Model` object ✓ |
| `/thinking` | `{ level }` | `set_thinking_level` ✓ | `{ level }` |
| `/branch` | `{ entryId }` | `fork` (from a user message on active branch) ✓ | `{ text, cancelled }` ✓ |
| `/clone` | — | `clone` ✓ | `{ cancelled }` |
| `/new` | `{ parentSession? }` | `new_session` ✓ | `{ cancelled }` |
| `/switch` | `{ sessionPath }` | `switch_session` ✓ | `{ cancelled }` |
| `/fork` | `{ entryId }` | `fork` ✓ | `{ text, cancelled }` |
| `/auto-compaction` | `{ enabled }` | `set_auto_compaction` ✓ | `{}` |
| `/auto-retry` | `{ enabled }` | `set_auto_retry` ✓ | `{}` |
| `/abort-retry` | — | `abort_retry` ✓ | `{}` |
| `/queue-modes` | `{ steeringMode?, followUpMode? }` | `set_steering_mode` / `set_follow_up_mode` ✓ | `{}` |
| `/extension-ui-response` | `{ id, value? , cancelled? }` | `extension_ui_response` ✓ | `{}` |

Design notes:

- **`/context` exists because the UI must never guess.** Any "what does the model see"
  display that is computed in the browser would be a second implementation of pi's rules;
  the endpoint computes it in agent-host with pi's own functions ✓.
- **`cancelled:true` is a first-class outcome**, not an error: extensions can veto
  switch/fork/clone/new ✓. The UI must show "extension cancelled this".
- pi's `bash` RPC command ✓ is **deliberately not exposed** — that would be pi-web
  executing commands on request. It is the one documented pi capability we omit (D-01).
- No `/files` write endpoints, ever (N-3).

## Config & resources

| Method | Path | Notes |
|---|---|---|
| GET | `/models` | `get_available_models` ✓ full `Model` objects incl. `contextWindow`, `maxTokens`, `cost` ✓ |
| GET | `/models/:provider/:id/thinking-levels` | `get_available_thinking_levels` ✓ (`["off"]` when no reasoning ✓) |
| GET | `/commands` | `get_commands` ✓ — extension/prompt/skill commands with `source`, `sourceInfo{path,source,scope,origin,baseDir}` ✓, feeding the composer's autocomplete; note built-in TUI commands are **not** included ✓, so the UI must not fake `/settings` or `/hotkeys` |
| GET | `/themes/current` | The palette pi-web is rendering (see [visual_design.md](visual_design.md)) |
| GET | `/settings/effective` | Read-only view of merged pi settings relevant to display (compaction thresholds, sessionDir) — never editable from the browser in v1 |

## Files (read-only, workspace-scoped)

| Method | Path | Notes |
|---|---|---|
| GET | `/files?cwd=&path=` | Listing or file text; realpath containment inside `cwd` (itself allowlisted); symlink policy per [security.md](security.md#read-only-file-viewer-and-path-containment) |
| GET | `/files/stat?cwd=&path=` | `{ size, mtime, mime, binary, truncated }` |
| GET | `/git/status?cwd=` | Read-only porcelain summary — **display only**, no commit/add/checkout endpoints (N-11) |
| GET | `/git/diff?cwd=&path=` | Unified diff text for the diff renderer |

---

## The event stream (SSE)

`GET /api/v1/sessions/:id/events?mode=mirror|attach`

Single channel per session per tab. Multiplexing several sessions in one stream is a P5
optimization; one-tab-one-session keeps ordering trivial.

### Wire format

```
id: <entryId-or-monotonicSeq>
event: <name>
data: <single JSON object>

```

| Aspect | Rule |
|---|---|
| `id:` | The pi **entry id** when the event maps to a persisted entry ✓; else a server monotonic sequence prefixed `s:`. `Last-Event-ID` therefore has durable meaning across restarts ✓ |
| Resume | Client sends `Last-Event-ID`; server replays `get_entries(since)` ✓ then goes live. Unknown cursor → `event: resync` + full snapshot, and HTTP-level `410` only if SSE could not even open |
| Heartbeat | `: ping` comment every `15 s` (defeats proxy buffering); client treats `45 s` silence as dead |
| Flush policy | Deltas coalesced up to `50 ms` or `2 KB` per frame batch — keeps token streaming smooth without flooding (budget in [event_rendering.md](event_rendering.md#performance-budgets)) |
| Headers | `Content-Type: text/event-stream`, `Cache-Control: no-store, no-transform`, `X-Accel-Buffering: no` |
| Ordering | Per-session total order = pi's event order, with the documented `message_end`-supersedes-buffers rule ✓ applied client-side |
| End | `event: stream_end { reason }` then close, on: detach, lease release, idle timeout, host death |

### Event names (v1)

Name = pi's own event name where one exists ✓, so the mapping is auditable. Payloads are
pi's payloads, minus fields the normalizer strips (never invented content).

**Run lifecycle:** `agent_start`, `turn_start`, `turn_end`, `agent_end`, `agent_settled`
(`aborted` ✓ — this is the state-reset signal).

**Messages:** `message_start`, `message_update` (`usage` + nested `assistantMessageEvent`
with types `text_start/text_delta/text_end/thinking_start/thinking_delta/thinking_end/
toolcall_start/toolcall_delta/toolcall_end/done/error` ✓), `message_end` (authoritative ✓).

**Tools:** `tool_execution_start`, `tool_execution_update` (`partialResult` ✓ — contract
says replace-or-extend is tool-specific ✓, so the client follows the
[per-tool table](event_rendering.md#tool-rendering-table) and never assumes append),
`tool_execution_end` (`isError`, `durationMs` ✓).

**Session/queue/state:** `queue_update` (`steering[]`, `followUp[]`, complete queues ✓),
`entry_appended` ✓, `session_info_changed` ✓, `thinking_level_changed` ✓,
`model_changed` (synthesized by pi-web from `set_model` success, because pi's RPC has no
dedicated event for it — flagged as synthetic in
[appendix_pi_facts.md](appendix_pi_facts.md#pi-web-synthesized-events)).

**Compaction:** `compaction_start` (`reason: manual|threshold|overflow` ✓), `compaction_end`
(`result` or `aborted`/`errorMessage`/`willRetry` ✓).

**Retry:** `auto_retry_start`, `auto_retry_end`, `summarization_retry_scheduled`,
`summarization_retry_attempt_start`, `summarization_retry_finished` ✓.

**Extensions/diagnostics:** `extension_error` ✓ (`extensionPath`, `event`, `error`),
`extension_ui_request` (dialogs `select/confirm/input/editor` block the agent until
answered ✓; notifications `notify/setStatus/setWidget/setTitle/set_editor_text` do not ✓).

**pi-web transport events:** `snapshot` (full state after connect/resync), `resync`,
`mode_changed` (`history|mirror|attach`), `lease_state`, `divergence_detected`,
`pi_version_warning`, `stream_end`, `host_exited`.

### Synchronisation guarantees

| ID | Guarantee |
|---|---|
| S-A | Every persisted entry reaches the client exactly once, in file order, across any reconnect sequence, via entry-id cursors ✓ |
| S-B | Transient streaming frames (`message_update`, `tool_execution_update`, retry progress) are best-effort: never replayed after a gap, always superseded by `message_end` / `tool_execution_end` / `entry_appended` ✓ |
| S-C | A client that reconnects mid-run sees: `snapshot` (persisted truth) → live events → correct final state when `message_end` lands. No phantom text from a dropped delta |
| S-D | `agent_settled` is the only "done" the UI trusts for resetting streaming state ✓ |
| S-E | Mirror frames carry `source:"mirror"`; attached frames carry `source:"live"` |

## Worked examples

**Open, watch, steer.**

```
POST /api/v1/sessions/01a1…/lease        { "mode":"attach","client":"c-77" }
→ 200 { "mode":"attach","token":"9f1…","expiresAt":"…" }

GET  /api/v1/sessions/01a1…/events       Last-Event-ID: (none)
← event: snapshot   data: { "entries":[…], "leafId":"a1b2c3d4", "model":{…}, "stats":{…} }

POST /api/v1/sessions/01a1…/messages     { "text":"explain the failing test","mode":"replace" }
→ 202 { "disposition":"started" }
← id: e101  event: agent_start      data: {}
← id: e102  event: message_start    data: { "message":{ "role":"assistant", … } }
←           event: message_update   data: { "usage":{…}, "assistantMessageEvent":{ "type":"text_delta","contentIndex":0,"delta":"The test" } }
← id: e107  event: tool_execution_start data: { "toolCallId":"call_1","toolName":"read","args":{ "path":"test/x.ts" } }
← id: e108  event: tool_execution_end   data: { "toolCallId":"call_1","toolName":"read","isError":false,"durationMs":12,"result":{…} }

POST …/messages/steer                    { "text":"focus on the assertion, not the fixture" }
→ 200 { "disposition":"queued" }
← id: e220  event: message_end      data: { "message":{ …authoritative… } }
←           event: agent_end        data: { "messages":[…], "willRetry":false }
← id: e231  event: agent_settled    data: { "aborted":false }
```

**Conflict on take-control** (terminal still live):

```
POST /api/v1/sessions/01a1…/lease { "mode":"attach","client":"c-77" }
→ 409 { "error":{ "code":"lease_conflict",
        "message":"session was written 400 ms ago; a terminal may still be running it",
        "details":{ "lastSeenEntry":"c3d4e5f6","suggestMirror":true } } }
```

---

## Why SSE not WebSocket

| Requirement | SSE | WebSocket |
|---|---|---|
| Auto-reconnect with resume token | Built into the browser: `Last-Event-ID` — which maps exactly onto pi's documented durable entry cursor (`get_entries since=<entryId>` ✓, "works as a durable cursor … even across client restarts") | Hand-rolled reconnect, backoff, and resume protocol |
| Direction | Server → client only; every client→server action is a command-shaped `POST` with an idempotency key and a real status code | Bidirectional, but then command responses must be re-correlated by hand |
| Infra | Plain HTTP: survives proxies, works with `curl`, logs as text, no upgrade handshake | Needs upgrade; some middlewares buffer or break it |
| Ordering | One stream per session, one total order | Same only if you also multiplex carefully |
| Cost | Slightly more TCP connections with many tabs | Fewer |

For v1's ceiling (a handful of tabs), the connection cost is irrelevant and SSE's resume
semantics are decisive. If P5 adds a multiplexed all-sessions channel, it is scoped as an
additional stream, not a migration.

## Client-side command rules

1. Send `prompt` with `mode:"replace"` when idle; with `steer`/`followUp` while streaming —
   the server rejects `replace` mid-run with `409 streaming_required` rather than guessing,
   mirroring pi's own refusal to guess ✓.
2. Reuse the same `Idempotency-Key` when retrying a timed-out `POST /messages`.
3. Never render "success" from a `202`: `disposition:"started"` means accepted, not
   completed ✓. Completion is `agent_settled` ✓.
4. Optimistic UI: show the user echo immediately with `pending:true`, reconcile against the
   persisted `user` entry when it arrives; on `409`/`502`, mark the echo failed and keep the
   text in the composer.
5. On `412` (fenced lease) the client stops all mutations, re-fetches `/lease`, and
   downgrades to mirror with an explanatory card.

## Conformance checklist

An implementation passes when: every endpoint above answers with the documented shape and
error codes; every event name is emitted at least once in the test corpus; S-A…S-E hold
under the reconnect matrix in [reliability.md](reliability.md#reconnect-matrix); the API
never exposes pi's `bash` command; and a byte-for-byte comparison of `GET /sessions/:id/raw`
before/after any pi-web operation shows **append-only** growth (S-11, S-3).
