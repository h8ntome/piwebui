# Reliability & Operations

pi-web is a supervising layer over three failure domains it does not control: the browser,
the pi process(es), and the session files. This file fixes the numbers, the detection, and
the user-visible behaviour for each.

---

## Tunables

Every one of these lives in one config object (`pi-web --set k=v`, `settings` file, or
`PIWEB_*` env) and is echoed by `GET /health`. Defaults chosen for a local single user.

| Key | Default | Meaning |
|---|---|---|
| `port` / `host` | `4319` / `127.0.0.1` | bind ([security.md](security.md#network-exposure)) |
| `leaseTtlMs` | `30000` | lease expiry |
| `leaseRenewMs` | `10000` | client renew cadence |
| `detachTtlMs` | `120000` | how long a server-held lease survives with no client; `0` = never release |
| `quietWindowMs` | `1500` | external-write quiet required before attach |
| `divergenceCheckMs` | `250` | mirror tail cadence while attached |
| `sseHeartbeatMs` | `15000` | comment frames |
| `sseClientDeadMs` | `45000` | no bytes → treat stream dead |
| `sseFlushMs` / `sseFlushBytes` | `50` / `2048` | delta coalescing |
| `commandTimeoutMs` | `15000` | non-prompt command deadline (`abort` allowed `30000` since pi waits for idle ✓) |
| `promptAckTimeoutMs` | `10000` | expect `202 {disposition}` ✓ |
| `hostPingMs` / `hostMissLimit` | `5000` / `3` | host liveness |
| `hostShutdownGraceMs` | `5000` | SIGTERM → SIGKILL |
| `idleDetachMs` | `60000` | dispose an attached AgentSession with no clients (pi's own lazy-create means an unprompted session leaves no file ✓, so this is cheap) |
| `maxAttached` / `maxMirrored` / `maxHosts` | `1` / `8` / `1` | capacity ([session_management.md](session_management.md#concurrency-limits)) |
| `hostEventQueueMax` | `5000` | backpressure watermark → `resync_required` |
| `mirrorBurstBytes` | `4194304` | max tail read per change |
| `idempotencyTtlMs` | `600000` | replay window for `Idempotency-Key` |
| `reconnectBackoff` | `500 ms → 8 s`, `×2`, `±25 %` jitter | client SSE retry (inside the browser's own default floor) |
| `logFile` | unset | logs off unless requested |

## Failure matrix

| ID | Failure | Detection | Time | User sees | Recovery |
|---|---|---|---|---|---|
| F-01 | Browser refresh / tab close mid-run | No SSE client | immediate | nothing (the run continues server-side within `detachTtl`) | reopen → `snapshot` + live tail (S-9); after `detachTtl` → run stopped, lease released, session shows final state |
| F-02 | Network drop / laptop sleep | SSE silence > `45 s` | 45 s | footer "Connection lost · retrying (n)"; composer disabled | auto-reconnect with `Last-Event-ID` ✓ → cursor replay ✓ |
| F-03 | Cursor no longer valid (rewritten file) | `410 cursor_expired` ✓ | on reconnect | one "rebuilding transcript" flash | full `snapshot`; no data loss |
| F-04 | agent-host crash / OOM | missed pings, exit code | ≤ `15 s` | red banner "agent host exited (n)"; transcript still readable from file | supervisor restarts host, releases its leases, clients auto-retry attach; pi's own file remains valid because writes are line-appends ✓ |
| F-05 | api-server crash | connection reset | immediate | "Disconnected" | restart; pi-web holds no conversation state (D-10) so clients just reload; leases expire by TTL |
| F-06 | Terminal opens the mirrored/attached session (S-3) | divergence check: foreign `parentId` | ≤ `250 ms` after the foreign write | divergence card, writes frozen | 3 choices: rebase / keep mine / fork both — never auto-merge |
| F-07 | Take-control while terminal still writing | quiet window unmet | immediate | `409 lease_conflict` → "Looks like it's still running in your terminal", [Mirror instead] | user stops the terminal or waits out the quiet window |
| F-08 | Provider error mid-run | `auto_retry_start` / assistant `error` stopReason ✓ | real time | inline "retry 1/3 · 529 overloaded" line on the row ✓ | pi retries itself ✓; final failure shows pi's message, composer re-enabled |
| F-09 | Compaction failure | `compaction_end` without `result`, with `errorMessage` ✓ | real time | amber banner on the compaction block + "Retry compact" (pi suggests fixing the provider problem and re-running ✓) | `/compact` retry; auto-compaction MAY be toggled ✓ |
| F-10 | Context overflow recovery | `compaction_start reason:"overflow"` + `willRetry` ✓ | real time | "Recovering from context overflow…" then continue | pi handles ✓; UI only narrates |
| F-11 | Extension throws | `extension_error` ✓ | real time | one non-modal line with `extensionPath` + event ✓; if it was fatal to the run, the run error shows too | never blocks other sessions |
| F-12 | Session deleted while open | file gone, or `list()` no longer returns it ✓ | ≤ `500 ms` | "This session was deleted at HH:MM", read-only | user reopens another session |
| F-13 | Workspace removed from allowlist while attached | lease renew checks allowlist | ≤ `10 s` | composer disabled: "workspace no longer allowed" | re-add or release |
| F-14 | pi upgraded to untested version | `probe()` mismatch ✓ | startup | amber banner + read-only mode (attach refused, `423 read_only`) ✓ | pin or upgrade pi-web; capabilities page lists the diff |
| F-15 | pi downgraded / `dist` layout moved | probe + contract snapshot test ✓ | startup | same as F-14 | same |
| F-16 | Disk full / read-only FS during a run | `appendFileSync` throws in pi ✓ → surfaces as run error | immediate | error on the run + `ENOSPC` verbatim | free space; note file remains at last complete line |
| F-17 | Session file huge (`> 200 MB`) | size check at open | immediate | "Very large session (n MB) — opening in mirror-only, windowed" | cursor-based reads ✓ keep it usable; never `readFileSync` |
| F-18 | Many sessions in a dir (`list()` cost) | slow first response | measured | rail shows progressive list (`onProgress` callback exists ✓) | cached list (`2 s` TTL) + `limit`/`cursor` |
| F-19 | SSE proxy buffering (tailnet/proxy setups) | client heartbeat timeout | `45 s` | "Connection lost" repeatedly | send `no-transform` + `X-Accel-Buffering: no` ✓ documented in deployment notes |
| F-20 | Two pi-web servers on one machine | both create sessions in one dir | divergence check | divergence card on the affected session | single-instance lock (`piweb.lock` via `proper-lockfile` ✓ pattern) at startup |
| F-21 | User force-takeover, then the old writer's next write | fencing token rejected | on that write | old client: "Another window took control at HH:MM" → mirror | automatic |
| F-22 | Clock skew between tabs | token/`expires_at` compare | — | none | server time is the only authority; clients send no timestamps that matter |
| F-23 | New session lost before first message | by design: no file until first user/assistant message ✓ | refresh | rail shows "not yet on disk"; text kept in composer draft | user prompts or recreates — matches pi behaviour |
| F-24 | Slow client (mobile on a bad link) | SSE backpressure, queue > watermark | seconds | coarser token flow, then `resync` | correct final state guaranteed (S-A) |

## Reconnect matrix

The exhaustive proof set for G-6. Each row is a test.

| # | Client state at disconnect | Server state | Expected after reconnect |
|---|---|---|---|
| C-1 | idle, full transcript | idle | identical, 0 extra events |
| C-2 | idle, full transcript | mid-run, several turns persisted | snapshot + live continuation, no duplicate rows |
| C-3 | mid-stream (partial assistant row) | same run still streaming | partial row rebuilt from `message_start`/replay or finalized by `message_end` ✓ |
| C-4 | mid-tool (`tool_execution_update` in flight) | tool still running | tool row shows running; final `tool_execution_end` ✓ gives authoritative result |
| C-5 | during compaction | compacting | `compaction_start` narration re-shown or `compaction_end` result applied ✓ |
| C-6 | during retry backoff | retrying | retry line present, then success/failure ✓ |
| C-7 | after the run finished | idle | file truth only; no phantom "running" state (R-5, R-7) |
| C-8 | cursor id deleted (file rewritten) | any | `410 cursor_expired` → snapshot, user informed |
| C-9 | lease held by us, TTL not expired | attached | attach restored instantly with same token |
| C-10 | lease expired during a long commute | attached→released | downgrade to mirror/history with explanation, run stopped |
| C-11 | phone asleep 6 h | anything | on wake: force resync (cheap) instead of replaying thousands of entries |
| C-12 | two tabs same session | attached in tab A | tab B follower/mirror; never two writers (S-10) |

## Backpressure & flow control

| Boundary | Control |
|---|---|
| pi → agent-host | In-process subscription; host must not do sync work in the handler — normalize + enqueue only |
| agent-host → api-server | Bounded queue `5000`; coalesce deltas; then `resync_required` (never unbounded growth). RPC driver: pi honours stdout backpressure but a client that stops reading stalls it ✓ — so the host always reads continuously ✓ |
| api-server → browser | Per-connection write watermark; when tripped, increase `sseFlushMs` adaptively and drop only preview deltas (never `message_end`, never entries) |
| Browser → DOM | One paint per frame; windowing; long code blocks render in slices |
| File tail | Burst cap `4 MB`, then re-snapshot |

## Idempotency & exactly-once

- **Commands:** `Idempotency-Key` on every mutating POST; the server replays the stored
  response within `10 min`. Prevents a retried `POST /messages` from prompting twice.
- **Events:** reducer idempotency by entry id + seq (R-8, RR-10) makes replay free.
- **Leases:** fenced tokens so an old holder cannot act after takeover (F-21).
- **Destructive ops:** delete/rename are single-attempt with confirmation; delete uses
  trash semantics ✓ so it is itself reversible.

## Supervision & lifecycle

```
pi-web (parent)
 ├── api-server            in-process module
 │    ├── agent-host #1    child_process.fork   →  pi SDK in-process  (owns leases)
 │    └── agent-host #n    (only with maxHosts > 1)
 └── mirror tailers        in-process fs.watch, no child
```

| Aspect | Rule |
|---|---|
| Restart policy | host restart with backoff `1 s → 30 s`; after 5 crashes in `5 min`, stop and require user action (banner + `POST /host/restart`) |
| Shutdown order | stop accepting requests → tell hosts to dispose sessions (`dispose()` aborts active work ✓) → flush → close SSE → close SQLite; `5 s` then hard kill |
| Orphans | On api-server start, drop `leases` rows whose `pi_pid` is dead; on host start, refuse any file another live host claimed |
| Crash-dump | Host exit code + last `200` stderr lines kept in memory, exposed at `GET /debug/host` (loopback + token) |
| Stdout purity | The RPC driver's child stdout is protocol-only ✓; pi-web pipes stderr to a separate log and never parses it as records ✓ |
| Session integrity checks | After any restart: re-read the tail of each previously owned file; if it grew with entries we did not write, treat as divergence, not error |

## Observability

| Signal | Detail |
|---|---|
| Structured logs | JSON lines, `level, ts, corr, session?, kind`; correlation id propagates api → host → SSE frame seq; no prompt text ever ([security.md](security.md#logging-and-privacy)) |
| `GET /health` | counts, hosts, capabilities, uptime, version, `piVersion`, active leases |
| `GET /debug/state` | per-session: mode, lease, leaf, last seq, SSE watermarks, queue depth, tailer offset |
| Client debug overlay | `?debug=1`: event rate, dropped deltas, reconnect count, DOM node count, frame time |
| Metrics (optional) | counters `sse_frames`, `deltas_coalesced`, `resyncs`, `lease_conflicts`, `divergences`, `host_restarts`; exposed locally, never pushed anywhere |
| Tracing | none; correlation ids are sufficient at this scale (a system that needs distributed tracing has outgrown its scope) |

## Operational SLOs (honest targets)

| | Target |
|---|---|
| Availability | whatever the machine is; pi-web adds no availability claim. Local process, restart by hand or by `launchd`/`systemd` unit provided as an example |
| Event loss | 0 persisted entries lost, ever (S-A) |
| Time to detect divergence | ≤ `250 ms` |
| Time to fail over a host crash | ≤ `15 s` to a usable banner, ≤ `5 s` after restart to a re-attach |
| Soak | 24 h continuous streaming in 4 sessions, RSS growth < `10 %`, 0 dropped entries |
| Cold start | < `5 s` to first byte on `/` (G-7) |
