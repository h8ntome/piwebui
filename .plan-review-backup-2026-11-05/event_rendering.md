# Event & Rendering Model

How pi's event stream and session file become pixels without ever lying. Owns the
reconstruction rules referenced by [api_spec.md](api_spec.md#the-event-stream-sse) and
[architecture.md](architecture.md#layer-2-agent-host).

---

## Pipeline

```
 pi core                       agent-host                        api-server                 browser
 ──────                        ──────────                        ──────────                 ────────
 AgentSessionEvent ─┐
 SessionManager ────┤  normalize  ──▶  wire event  ──▶  fan-out + coalesce ──▶  reducer ──▶ view ──▶ DOM
 session .jsonl ────┘   (rules       {name, seq,        (SSE, ≤50 ms            (idempotent,  (memoized
  (tail, mirror)         N-1..N-7)    entryId?,          batch, LF-only)         keyed rows)   rows)
```

Two independent feeds reach the same reducer: **live events** (from a running pi) and
**file truth** (persisted entries, from snapshot, replay-after-cursor, or mirror tail).
They are not two sources of truth — the file is the truth, live events are a projection of
it that arrives earlier. That single sentence is the reason most of these rules exist.

## Authority rules

| ID | Rule | Why |
|---|---|---|
| R-1 | Persisted entries always overwrite any streamed state for the same entry id | `message_end` is authoritative ✓; deltas are a preview |
| R-2 | A `message_update` buffer is discarded, never merged, when the authoritative block arrives (`text_end` / `thinking_end` / `toolcall_end` / `message_end` ✓) | pi's docs state reconstruction must replace buffered data with the completed content ✓ |
| R-3 | `contentIndex` identifies the content block; deltas append **per index**, never to a single string | One reply can interleave text, thinking, and tool-call blocks; concatenating them corrupts all three ✓ |
| R-4 | `toolCallId` correlates tool lifecycle ✓; `partialResult` semantics are **tool-specific** (replace-or-extend), so the per-tool table below governs, and the safe default is replace | pi documents that the contract depends on the tool ✓ |
| R-5 | Only `agent_settled` resets "running" state. `agent_end` does not | retries, overflow recovery, compaction retry, steering, and follow-ups can follow `agent_end` ✓ |
| R-6 | Queue chips come from `queue_update`'s **complete** lists ✓, never from client bookkeeping | the client's view of a queue is always potentially stale |
| R-7 | `usage` and totals come from `get_session_stats` ✓, never from client arithmetic over deltas | provider usage is reported, not derivable; `contextUsage` is legitimately `null` right after compaction ✓ → render "measuring…", never 0 |
| R-8 | A duplicate event (same name + same entry id + same seq) is dropped silently | reconnects can replay; idempotence is the resume mechanism |
| R-9 | Unknown event/entry/field → retained as a raw node, rendered as `unknown`, and logged once. Never thrown, never dropped | forward-compat with pi upgrades (G-8, G-9) |
| R-10 | The reducer never invents content: no client-side summarization, no re-ordering, no synthesis of a missing tool result | the contract in [vision_and_scope.md](vision_and_scope.md#the-contract) |

### Normalization rules

| ID | Rule |
|---|---|
| N-1 | Both drivers are mapped to **delta + authoritative-end**. `SdkDriver` receives cumulative `message` snapshots on `message_update` ✓; the host strips the cumulative field and emits only the nested `assistantMessageEvent` ✓ — identical to the RPC wire shape ✓ |
| N-2 | Host stamps each event with `seq` (monotonic per session) and `entryId` when the event corresponds to a persisted entry; SSE uses it as the `id:` line ✓ |
| N-3 | Extension-UI requests pass through unmodified ✓, with `extensionPath` attached |
| N-4 | Events for a session with no subscribed client are **not** buffered beyond `5 000` frames; past that, mark `resync_required` and rely on cursor replay (S-A) |
| N-5 | `model_changed` is synthesized by the host on a successful `set_model` (pi's event list has no equivalent ✓) and is labelled synthetic |
| N-6 | Mirror-derived events carry `source:"mirror"`; live ones `source:"live"`. On conflict for the same entry id, mirror (file truth) wins — R-1 |
| N-7 | Timestamps pass through untouched (ISO entry stamps ✓, unix-ms message stamps ✓) so a browser in another timezone cannot alter what is displayed as recorded data |

## Client state shape

```
SessionView {
  sessionId, sessionFile, cwd, mode, lease,
  entriesById:      Map<entryId, Entry>          // file truth
  childIds:         Map<entryId, entryId[]>      // tree
  leafId:           entryId | null               // pi: last entry on open ✓
  activeBranch:     entryId[]                    // computed, pi's rules ✓
  live:             Map<contentKey, StreamBuffer>  // transient, discarded on R-2
  tools:            Map<toolCallId, ToolState>   // start/update/end ✓
  queues:           { steering: text[], followUp: text[] }  // ✓
  status:           idle | streaming | compacting | retrying | settled
  stats:            SessionStats | null          // ✓
  connection:       live | reconnecting(n) | dead
}
```

Everything is derived from `entriesById` + `leafId` except `live`, `tools`, `queues`,
`status`, `connection`. Rebuilding the first three from a snapshot alone must reproduce the
screen exactly — that is the reconnect test (S-4, G-6).

## Reducer rules

| ID | Rule |
|---|---|
| RR-1 | Entries are stored by id and rendered by `activeBranch` order, never insertion order — the file is a tree ✓ and mirrors and attaches must agree |
| RR-2 | On `entry_appended` ✓ / mirror `entry`: insert, link to `parentId`, and if it extends the current leaf, move `leafId` |
| RR-3 | On `message_start`: create a placeholder row keyed by message identity with `pending: true`; never render it as complete |
| RR-4 | On `message_end`: replace the row wholesale ✓, clear that message's `live` buffers (R-2) |
| RR-5 | On `tool_execution_start`: create tool state keyed by `toolCallId` ✓; on `update`: apply the per-tool rule; on `end`: store `result`, `isError`, `durationMs` ✓ |
| RR-6 | Optimistic user echo lives in a separate map (`pendingEcho`), removed when the real `user` entry arrives (RR-2), converted to "failed" on `409`/`502` with text returned to the composer |
| RR-7 | `status` becomes `streaming` on `agent_start`, `compacting` on `compaction_start` ✓, `retrying` on `auto_retry_start` ✓, and `idle` **only** on `agent_settled` ✓ (R-5) |
| RR-8 | On `resync`/`snapshot`: replace `entriesById`/`leafId` wholesale, preserve scroll anchor by entry id, keep unsent composer text untouched |
| RR-9 | On `divergence_detected`: freeze mutation, keep rendering, surface the card ([ui_design.md](ui_design.md#divergence-card)) |
| RR-10 | Reducers are pure and idempotent; applying the same event twice is a no-op (R-8) |

## Stream reconstruction (prose algorithm)

For each in-flight assistant message:

1. `message_start` → open a row; create an empty buffer slot per `contentIndex` as it
   first appears.
2. `message_update` → dispatch on `assistantMessageEvent.type` ✓:
   - `text_start` / `text_delta` → append `delta` to that index's text buffer.
   - `text_end` → **replace** that buffer with `content` ✓ (authoritative block).
   - `thinking_*` → same pair against the thinking buffer; if the provider marks it
     `redacted`, show the marker and never fabricate text ✓.
   - `toolcall_start` → open tool-call stub with `id` + `toolName` ✓.
   - `toolcall_delta` → append the serialized-arguments fragment to that call's arg buffer;
     parse leniently and show partial JSON as plain text (never half-rendered "arguments").
   - `toolcall_end` → replace with the complete `ToolCall` ✓.
   - `done` / `error` → provider-stream end; carry `reason` ✓ into row status.
3. Update the cumulative usage readout from `message_update.usage` when non-zero ✓
   (providers may report nothing until completion ✓ — so "0" is not shown, "—" is).
4. `message_end` → discard all buffers for that message, keep only the final message ✓.
5. Later, the persisted `message` entry arrives (file truth) → identical content, so it
   must not create a second row (identity = entry id / message identity, RR-2 + R-8).

### Worked timeline

```
t+0    message_start    assistant, content=[]                       → row("assistant", pending)
t+12   update thinking_start   idx0                                 → thinking slot 0
t+20   update thinking_delta   idx0 "The test a"                    → "The test a"
t+31   update thinking_delta   idx0 "sserts X"                      → "The test asserts X"
t+40   update thinking_end     idx0 content="The test asserts X."   → replace (final)
t+44   update text_start       idx1                                 → text slot 1
t+50   update text_delta       idx1 "The "                          → "The "
t+55   toolcall_start          idx2 id=call_1 toolName=read         → tool stub
t+61   toolcall_delta          idx2 '{"path":"te'                   → partial args as text
t+70   toolcall_end            idx2 ToolCall{read,test/x.ts}         → replace stub
t+72   tool_execution_start    call_1                                → tool row "running"
t+84   tool_execution_end      call_1 ok 12ms                        → tool row ok
t+90   update text_delta       idx1 "test asserts the wrong value."  → full text
t+96   message_end             message{...}                          → whole row replaced ✓
t+98   turn_end ✓                                                            → (no state change)
t+99   agent_end ✓                                                           → still "running" (R-5)
t+101  agent_settled {aborted:false} ✓                                       → status=idle
```

If the connection dies at t+50: on reconnect, `snapshot`/`get_entries(since)` ✓ returns
nothing new (the message is not persisted yet), the run continues, and the client re-opens
the row from `message_start` re-replay or, if the run already finished, from the persisted
`message` entry. Either way the final row equals the file's row (S-A, C).

## Tool rendering table

| Tool | Update policy | Live rendering |
|---|---|---|
| `bash` | extend | tail of streamed output, `[n lines]` counter; note `bash_execution_update` is RPC-only and belongs to pi's own `bash` **command**, which pi-web does not expose ([api_spec.md](api_spec.md#command-semantics)) ✓ |
| `read` / `write` / `edit` | replace | status only until `tool_execution_end` |
| `grep` / `find` / `ls` | replace | status + result count on end |
| `codemode` | extend | streamed console lines, capped |
| unknown | replace | status + duration only ✓ |

## Mirror tail parsing

| Concern | Rule |
|---|---|
| Line splitting | split on `0x0A` only; strip optional preceding `0x0D`. **Never** `readline` — it also splits on `U+2028`/`U+2029`, which are legal inside JSON strings ✓ |
| Partial trailing line | hold; emit only after its LF (an entry appended mid-read must never render half a message) |
| Encoding | UTF-8 decode with a persistent decoder (multi-byte sequences can straddle a chunk boundary) |
| Shrink / rotation | if `size < lastByteOffset` → full re-read + `resync` to clients |
| Large changes | read in `64 KB` chunks; cap `4 MB` per change burst, then re-snapshot |
| Watch backend | `fs.watch` with a `50 ms` debounce; fallback poll every `250 ms` on platforms where events are unreliable (network mounts, some containers) |
| Cost | incremental only; never re-parse the head; index `byId` incrementally like pi's own `_buildIndex` ✓ but keeping `leafId` = last line ✓ |
| Emit shape | one SSE `entry` frame per entry, `source:"mirror"`, `id:` = entry id ✓ |

## Performance budgets

| Budget | Target | How measured |
|---|---|---|
| SSE frame → DOM paint | p95 < `50 ms` local, < `120 ms` over tailnet | perf marks, `render` timestamp in a debug overlay |
| Delta coalescing | ≤ `50 ms` or `2 KB` per batch | unit test with a synthetic 10 000-delta burst |
| Long-run frame rate while streaming | ≥ 50 fps on a 2019 laptop | Playwright trace + `requestAnimationFrame` sampler |
| DOM rows | ≤ `600` nodes in the transcript at any time | virtualization; assertion in e2e (S-12) |
| Reducer cost | < `1 ms` per event for a 5 000-entry session | micro-benchmark in CI |
| Mirror tail CPU | < `3 %` of one core while 4 sessions change at 10 lines/s | soak test, 30 min |
| Memory (client) | < `250 MB` at 5 000 entries; entries older than the window keep only their summary row, full text re-fetched by cursor ✓ on expand | heap snapshot in CI |
| Server memory | < `200 MB` baseline + < `20 MB` per attached session | soak test |
| Cache invalidation | one render pass per animation frame, coalesced | `useSyncExternalStore` subscription, no per-event setState |

## What the renderer must never do

- Reconstruct a system prompt or tool list client-side for display of "what the model
  sees" — that comes from `GET /sessions/:id/context`, computed by pi ✓.
- Merge two assistant messages that look similar, or dedupe by content.
- Pretend a truncated tool result is complete; pi marks truncation (`truncated`,
  `fullOutputPath` ✓) and pi-web shows that marker with the path.
- Render `custom.data` as anything other than JSON (extensions own that meaning ✓).
- Fill in a missing tool result with "no output": record absence honestly.
- Show a spinner while waiting for an HTTP `POST` that already returned `202` — the run is
  represented by events, not by request state ✓.
