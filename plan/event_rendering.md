# Event and rendering model

## Authority

- Original persisted entries are archival truth. Runtime state is authority for current
  leaf, run state, pending inputs, current config, dialogs and in-flight previews.
- File-only mirror cannot reconstruct unsaved tokens, tool progress, queue state or
  navigation that has not appended a record. Show unknown/live-state-unavailable.
- Persisted projection is distinct from an exact provider payload. No extra model calls
  or context hooks may be run merely to populate a browser preview.
- Unknown fields/types are retained in bounded raw inspection; nothing executes from data.

## Normalization

All drivers produce pi-web envelopes from [api_spec.md](api_spec.md). Per runtime/session
generation, assign live message IDs, tool-call identities and monotonic transport seq.
Pi entry IDs exist only when persisted. On message persistence, attach its known owner
message mapping and replace the provisional row. If a mapping is unavailable after a
restart, discard provisional rows and rebuild from a consistent snapshot. Never match by
text, timestamps or model name.

Prefer owner-side cumulative preview snapshots with content-block revision numbers.
Delta emission is allowed only against a known revision. SDK cumulative fields, RPC deltas
and extension event wrappers differ; P0 fixtures prove each chosen adapter. Streaming
blocks are keyed by message ID and `contentIndex`, not one concatenated string.
Authoritative block/message ends replace preview buffers wholesale.

Pi built-in **bash tool updates are cumulative snapshots** in the inspected 1.5.0 build;
replace, do not append them. Unknown/custom tool updates default to replacement unless a
verified per-tool contract says otherwise. `codemode` must be tested, not assumed append.
RPC `bash_execution_update` belongs to a different command and is not our tool interface.

## Reducer rules

| ID | Rule |
|---|---|
| RR-1 | Ignore duplicate transport sequence in the same epoch; on epoch/generation change require snapshot. |
| RR-2 | Persisted entries keyed by file generation + entry ID; conflicting duplicate IDs are diagnostics, not silent overwrite. |
| RR-3 | Compute active branch from owner leaf when live and file leaf when mirrored; preserve abandoned branches for inspection. |
| RR-4 | Keep previews separate from entries; replace using verified message-to-entry mapping. |
| RR-5 | `snapshot` replaces authoritative state, preserves UI drafts/scroll anchors where IDs still exist, clears stale previews. |
| RR-6 | Lifecycle comes from complete owner snapshots/events. `agent_settled` completes an observed run; a reconnect snapshot may already say idle without replaying that event. |
| RR-7 | Queue lists and operation receipts are owner-reported; pending optimistic input is not a persisted user message. |
| RR-8 | Errors/timeouts retain draft text; unknown dispatch outcome is not shown as failed-and-safe-to-retry. |
| RR-9 | Compaction/context-edit projection never deletes original archival rows. Unknown records get raw nodes. |
| RR-10 | Conflict freezes remote mutations; no automatic rebase/merge or invented missing result. |

State slices: persisted entry index/tree/file leaf, runtime identity/leaf/status/preview,
tools, queues, pending dialogs, capabilities, operations, control grant, connection,
scroll/find/draft/preferences. Composer presentation is derived from these orthogonal
states with precedence offline/conflict/read-only → dialog/compaction restrictions →
streaming/idle. A queued message can coexist with streaming; it is not an exclusive mode.

## Reconnect

Use the subscribe/snapshot barrier in the API spec. Snapshot contains current cumulative
preview and pending dialogs, not only persisted messages. Missing delta base revision
requests resync; never append later fragments to an empty row and call it reconstructed.
Source loss is visible. A file tail can restore final content but cannot restore transient
progress; do not promise exactly-once event delivery or full token replay.

## File tail

- LF-only framing; optional preceding CR stripped. Persistent UTF-8 decoder or byte-level
  newline framing handles split multibyte sequences. U+2028/U+2029 inside strings are data.
- Hold incomplete final record. Invalid complete lines produce a diagnostic with offset;
  no source repair. Impose record byte/depth limits with bounded raw download, not an
  unbounded partial-line buffer.
- Watch file and parent directory; periodic stat/reconciliation catches missed events,
  atomic replacement, deletion, same-size replacement and rename. Track inode/device,
  generation, size, offsets and tail fingerprint as appropriate to the platform.
- Read 64 KiB chunks, yield every 4 MiB work burst, then continue from offset. Do not
  repeatedly restart full reads because a file exceeds the burst budget.
- Initial subscribe/read/tail needs the same high-water barrier so appends during open
  are neither missed nor duplicated. Unknown legacy formats remain read-only if parsing
  cannot be proven compatible.

Node readline is deliberately avoided for this protocol: the local runtime experiment
split both U+2028 and U+2029. Reference: [Node readline](https://nodejs.org/api/readline.html).

## Performance and bounded memory

| Metric | Target / measurement |
|---|---|
| Local event → paint | p95 <50 ms on recorded hardware |
| Coalescing | <=50 ms or 2 KiB, replace superseded previews, preserve latest state |
| Large session | 5,000 entries first usable view <1.5 s; test >200 MiB files and huge single records |
| Window | <=150 mounted transcript rows plus <=30 overscan each side; measure total DOM separately |
| Client heap | target <250 MiB at 5,000-entry reference fixture |
| Server | measure API/read-worker/each Pi host separately; do not promise SDK hosts fit in 20 MiB |
| Queue | 5,000 frames **and** 8 MiB per stream, whichever first; then snapshot/disconnect slow consumer |

Lazy-load entry bodies and search through bounded server-side pages. Windowed DOM does
not bound JS memory. An entry-after cursor is not random access to an entry body: use
the explicit one-entry endpoint. Limit giant Markdown/code blocks and raw JSON expansion.
Never drop a durable record then claim complete history; page/reload it from source.
