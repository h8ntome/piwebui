# Reliability and operations

## Defaults

| Knob | Default |
|---|---|
| Bind | 127.0.0.1:4319 |
| Active managed runtimes | 4, one process per session; additional work queues/refuses explicitly |
| Terminal bridges | independent discovered processes; at least four concurrent sessions tested across modes |
| File mirrors | 8 watched views; bounded connections and bytes |
| Browser grant TTL / renew | 30 s / 10 s; expiry affects browser control only |
| Browser disconnect run timeout | **none**; keep active/queued/compacting/retrying/dialog work |
| Settled managed host cleanup | 60 s with no clients, no queued work and no pending dialog |
| Heartbeat / client silence | named SSE event every 15 s / 45 s |
| Tail reconciliation | watch + periodic stat, target 250 ms local; platform behaviour measured |
| Dispatch acknowledgement | 10 s; timeout yields reconciliation, not automatic retry |
| Runtime health | ping 5 s, 3 misses; busy event loops may require suspect state before declaring death |
| Stream queue | 5,000 frames or 8 MiB, whichever first |
| Operation receipt retention | 24 h after final state; active/unknown retained until resolved |
| Graceful shutdown | drain by default; explicit stop aborts then waits, never pretends timeout completed shutdown |

These are implementation defaults, not claims of available current Pi capabilities.
Provider response time and Pi host memory must be measured independently from UI latency.

## Failure behaviour

| ID | Failure | Response |
|---|---|---|
| F-01 | Browser closes/phone sleeps | All active runs continue. Controller may expire; reacquire on return, snapshot state. |
| F-02 | SSE loss/eviction/restart | New epoch or missing cursor → snapshot barrier; no duplicate rows/partial delta corruption. |
| F-03 | Terminal bridge unavailable | Disable commands; persisted mirror remains, do not spawn another owner. |
| F-04 | Managed host crashes | Mark operations unknown/failed as supported by evidence; file readable; no automatic prompt replay. |
| F-05 | API server dies | External terminal Pi continues independently. Managed host detects IPC parent loss and aborts/exits or follows a proven reconnect protocol; v1 uses fail-closed exit. |
| F-06 | Foreign writes/file mismatch | Freeze commands, diagnose, request safe abort, preserve source; no auto merge or promise that effects were prevented. |
| F-07 | Unbridged file requested for control | Refuse automatic takeover; require confirmed closed-writer import flow or mirror. Quietness alone is insufficient. |
| F-08 | Provider retry/overflow/compaction | Render owner-reported state. Never start our own retry/model loop. |
| F-09 | Waiting extension dialog | Persist in runtime memory and resnapshot. A browser absence is not consent/cancellation. |
| F-10 | Partial/invalid file tail | Hold partial bytes with cap, diagnose invalid complete lines; never repair original. |
| F-11 | File deleted/replaced/shrunk | Detect generation change even same size; invalidate cursors, freeze unsafe mutations, resnapshot/mark unavailable. |
| F-12 | Version/adapter mismatch | Read-only; no automated package downgrade/upgrade or unsafe capability inference. |
| F-13 | Disk full/write error | Show actual Pi error; do not guarantee source has no torn record; inspect/diagnose. |
| F-14 | Multiple server instances | Lock/reservation prevents participating duplicates; uncooperative writers remain outside that guarantee. |
| F-15 | Workspace removed | Immediate API access/control restriction; ongoing run disposition is explicit, never accidental lease expiry abort. |
| F-16 | Slow client/huge record | Byte-bounded queues, coalesce previews, resync/disconnect; runtime never waits on browser rendering. |
| F-17 | Ambiguous command acknowledgement | Same operation ID queries same owner receipt; unknown after owner death, no automatic resubmit. |
| F-18 | Reload/session switch | New generation, replace captured contexts, invalidate stale control/dialog/command targets. |
| F-19 | Stale socket/PID reused | Authenticated handshake/start identity fails; no deletion or takeover of unrelated process. |
| F-20 | NetBird/HTTPS path fails | Offline UI, local run continues; no fallback to public exposure/HTTP bearer URLs. |

`dispose()` starts cancellation in the installed SDK; it is not by itself a proof of
idle/flushed/child-exited state. Stop-for-terminal waits for supported idle/settled and
child exit before releasing ownership. Explicit forced process termination reports
interrupted state and requires file verification; a 5 s kill timer is not clean handoff.

No automatic host restart into an active/ambiguous file. Supervisor can restart an empty
host infrastructure process, but session reopen is a separate ownership-checked action.
API server restart reconciles prior PID/start identity, local sockets and reservations
before offering control. PID dead alone is not enough when PID reuse is possible.

## Recovery matrix

| ID | Disconnect point | Required result |
|---|---|---|
| C-1 | idle | snapshot says idle without requiring a replayed agent_settled |
| C-2 | several entries missed | exact persisted history without duplicate rows |
| C-3 | half an assistant block | cumulative owner preview or explicit resync; no suffix-only reconstruction |
| C-4 | tool running | current tool snapshot and eventual result; bash output not doubled |
| C-5 | compacting/retry | actual owner status and progress availability |
| C-6 | dialog pending | same request ID/options/deadline, one valid response |
| C-7 | run finished while absent | idle/settled snapshot and final persisted entries |
| C-8 | transport epoch/log lost | full resnapshot; persisted cursor separate |
| C-9 | controller expired | run continues, reacquire browser control, stale commands rejected |
| C-10 | phone sleeps six hours | runs finish/await dialog naturally; bounded resnapshot, no background timeout abort |
| C-11 | reload/switch/file replacement | generation-aware invalidation and correct target binding |
| C-12 | four sessions, two tabs each | independent runtime state, bounded connections, one web controller per runtime |

## Observability and verification

Authenticated health reports counts/capabilities/owner identities and sanitized fault
metadata, no secrets or raw stderr. Client diagnostics show source, generation, seq,
resync count and pending operation IDs. Logs are content-free. No outbound telemetry.

Release soak: 24 h with four active/queued workloads and scripted disconnects/reconnects,
resource baselines recorded per process. Do not label this passed without running it;
keep skipped/manual checks visible. No provider-costly live soak without an authorized
model/testing budget; use a deterministic local provider adapter for automated stress
and explicitly report which real-provider smoke tests were performed.
