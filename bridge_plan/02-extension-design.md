# 02 — `@piwebui/pi-web-bridge`: the new Pi extension

A single-file, zero-dependency Pi package that runs **inside** a terminal `pi` process, dials the
running pi-web server over a Unix socket, streams that pi's live events out, and executes commands
that come back in. Public `ExtensionAPI`/`ExtensionContext` only — no monkey-patching, no private
`dist` imports, no second writer of the session file, no debugger attach.

```
pi (TUI, pid 710958) ── ExtensionAPI events ──▶ BridgeHub (globalThis singleton)
                                                   │  one UDS connection per discovered server
                                                   ▼  JSONL: hello/ev/res  ▲  auth/cmd/ping
                                                        pi-web server bridge listener
```

---

## 1. Package layout

```
packages/pi-extension/                       # new workspace
├── package.json
├── extensions/
│   └── pi-web-bridge.js                     # the whole extension (Node builtins only)
├── README.md                                # install + what it does + threat model (short)
└── test/
    ├── descriptor.test.mts                  # resolution order, malformed descriptor
    ├── framing.test.mts                     # frame codec, seq/replay ring, backpressure
    ├── lifecycle.test.mts                   # fake ExtensionAPI: session switch, stale handle
    └── commands.test.mts                    # command mapping, busy policy, op dedup
```

```json
{
  "name": "@piwebui/pi-web-bridge",
  "version": "0.1.0",
  "type": "module",
  "description": "pi-web bridge for terminal pi sessions: live streaming + browser prompts, no configuration.",
  "keywords": ["pi-package", "pi", "pi-web", "bridge"],
  "pi": { "extensions": ["./extensions/pi-web-bridge.js"], "changelogPath": "./CHANGELOG.md" },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*" },
  "engines": { "node": ">=22.19.0" },
  "publishConfig": { "access": "public" }
}
```

Rules obeyed: no `dependencies` (P-4 — bundling host packages is an explicit anti-pattern, and the
extension must survive a `--offline` install), conventional `extensions/` directory **plus** the `pi`
manifest (so both auto-discovery and `pi install` find it), `.js` not `.mjs` (P-1), `pi-package`
keyword so it is listable in the package gallery.

Install paths, all equivalent and all zero-config afterwards:

| Path | Command |
|---|---|
| npm (default) | `pi install npm:@piwebui/pi-web-bridge` |
| try once, no settings change | `pi -e npm:@piwebui/pi-web-bridge` |
| repo checkout / offline | `pi install ./packages/pi-extension` (verified §A.6) |
| no `pi` CLI available | `pi-web install-extension` (copies the same file to `~/.pi/agent/extensions/pi-web-bridge.js`) |

`pi-web install-extension` is the only surviving installer: it copies the file shipped inside
`@piwebui/pi-adapter` (renamed `.js`), deletes a legacy `pi-web-bridge.mjs`, and prints what it did.
It does **not** touch `settings.json` (auto-discovery covers it) and does **not** deal with tokens.

## 2. Configuration: descriptor-first

### 2.1 What the server publishes

`<dataDir>/bridge.json`, `0600` in a `0700` dir, rewritten on every serve start and on token rotation:

```json
{
  "v": 1,
  "serverId": "k7Q2m9xa",
  "protocol": [1],
  "socket": "/home/hadi/.pi-web/bridge-k7Q2m9xa.sock",
  "token": "Zm9vYmFy…(43-char base64url)",
  "http": "http://127.0.0.1:4319",
  "dataDir": "/home/hadi/.pi-web",
  "pid": 4112, "procStart": 1794123456789,
  "piwebVersion": "0.2.0",
  "startedAt": "2026-11-08T08:00:00.000Z",
  "updatedAt": "2026-11-08T08:00:00.000Z"
}
```

and, when `--data-dir` is not the default, a pointer
`~/.pi-web/servers/<serverId>.json` containing `{ "descriptor": "/abs/path/to/<dataDir>/bridge.json" }`
so a non-default server is still discoverable from a shell that knows nothing about it.

### 2.2 Extension resolution order (first hit wins, every step logged)

```
1  PIWEB_BRIDGE_DISABLE=1                     → disabled, no socket, no retry, no noise
2  PIWEB_BRIDGE_FILE=/path/bridge.json        → that descriptor
3  PIWEB_BRIDGE_SOCKET + PIWEB_BRIDGE_TOKEN   → inline descriptor (tests, containers)
4  $PIWEB_DATA_DIR/bridge.json
5  $PI_CODING_AGENT_DIR/../pi-web/bridge.json → “next to my agent dir” heuristic
6  ~/.pi-web/bridge.json                      → the normal case
7  ~/.pi-web/servers/*.json                   → other servers (multi-server fan-out)
8  legacy: PIWEB_BRIDGE_DIR + PIWEB_BRIDGE_TOKEN (old registry mode, §7)
```

Malformed/expired descriptor → **visible** one-line `ctx.ui.notify()` in the TUI with the fix command
(`pi-web` not running? wrong data dir?), once per process, never a loop.

`env PIWEB_BRIDGE_MODES=tui` (default) gates which run modes bridge at all; `print`/`json`/`rpc`
sub-processes (pi-subagents children, `pi -p`, `pi-web`'s own managed host via
`PIWEB_MANAGED_HOST=1`) stay unbridged. `ctx.mode` is the gate (P-7, measured §A.1).

### 2.3 Multiple servers

The extension may hold connections to up to `PIWEB_BRIDGE_MAX_SERVERS` (default 4) servers at once —
each gets its own connection, `hello`, event stream and command channel. pi serialises input itself,
so two browsers on two servers driving one terminal is safe (and is the same situation as two browser
tabs on one server). Every connection is logged with its serverId.

## 3. Process-global hub (the piece that makes session switching work)

Pi re-instantiates extensions on `/new`, `/resume`, `/fork`, `/reload` (P-6, measured §A.3), and a
`pi` handle captured by a dead instance throws (B-11). Therefore: **the socket belongs to the process,
the capabilities belong to the current instance.**

```js
// every module load of every instance:
const hub = (globalThis.__piwebBridge ??= BridgeHub.create());   // { conns, ring, servers, seq }
hub.bindInstance(pi);                                            // refreshes the live `pi` handle
pi.on("session_start", (_e, ctx) => hub.bindSession(pi, ctx));   // refreshes pi+ctx, bumps sessionGen
pi.on("session_shutdown", (e) => hub.instanceShutdown(e.reason));
```

`BridgeHub` owns: the discovered server list, one connection per server, the outbound replay ring,
the live preview/tool state, `runtimeId` (per **process**, minted once), `sessionGeneration` (per
`session_start`), the operation-dedup set, and the pi-version/`procStart` attestation facts.

Connection startup is deferred to `session_start` per the documented rule (P-5) — **not** the factory:

```
session_start(reason)
  ├─ hub.bindSession(pi, ctx)
  ├─ hub.advertiseAll()        // hello + registry update per connection   (async, never awaited by pi)
  └─ ensure watchers/retry timers (unref'd)

session_shutdown(reason)
  ├─ reason "quit"      → hub.closeAll();  nothing left behind
  ├─ reason "reload"    → keep sockets; bump runtimeGeneration sentinel; re-advertise on the next session_start
  └─ new|resume|fork    → keep sockets; clear session-scoped state (previews, tools, dialogs);
                           re-advertise on the next session_start (arrives milliseconds later, §A.3)
```

No socket teardown on session replacement (fixes B-5). If a new instance ever arrives while the old
hub is still live, the hub is idempotent: `runtimeId` is reused, `bindInstance` overwrites, and the
double-load guard (§6.4) prevents duplicate *processes* from colliding.

Timers are `unref()`d, sockets are `unref()`d, and every handler is wrapped in
`try/catch` that reports to `hub.diag` rather than throwing into pi. Nothing in the extension may
slow pi down: the event fan-out path is O(1) map writes plus a coalesced `write()`.

## 4. Connection behaviour

In dial mode the extension writes **nothing to disk**: no registry record, no per-runtime socket, no
pid file — the only artifacts are the server's own `bridge.json` + `bridge-<serverId>.sock`. That is
what removes the stale-artifact class of failures (B-5/B-6/B-7 leftovers on kill -9) instead of
scheduling their cleanup. (Legacy mode, §7, keeps its records for exactly one more release.)

| Situation | Behaviour |
|---|---|
| first connect | on `session_start`, dial; `auth` frame is the first write; wait `auth_ok` (5 s deadline) |
| server not running / no descriptor | quiet: no socket, no notify (nothing to fix yet); re-scan descriptor paths on a 60 s timer (plus `fs.watch` on the parent dir where available) |
| server starts later | connect within the retry window — **this is what makes "install pi-web while pi is running" work**: backoff `1s,2s,5s,10s,15s` (cap) + jitter, and an immediate retry on descriptor/socket `change` |
| server restarts (new socket) | `connect` fails → same backoff; on success, re-`hello` with `resume: {lastSeq}` so the server can pick up without a full resync |
| connection drops mid-run | keep streaming state locally (the ring, §5.1); on reconnect replay frames with `seq > lastAckedSeq` (bounded 2000 frames / 4 MiB), else send `ev: gap` and let the server resnapshot |
| pi exits (`/quit`, Ctrl-C, SIGTERM) | `session_shutdown{quit}` → close sockets, `unref` everything; the server sees `end`/EOF and marks the runtime gone |
| pi SIGKILLed | nothing to clean on the server side beyond dropping the connection — no registry files to expire (an advantage of D-1) |

`hello` carries everything the server needs to adopt and to attest:

```json
{ "t":"hello", "protocol":1, "minProtocol":1,
  "runtimeId":"9f2c…","pid":710958,"procStart":1794126936000,
  "sessionId":"01a1ba53-acf3-…","sessionFile":"/abs/…jsonl","cwd":"/abs/project",
  "piVersion":"1.5.0","piMode":"tui","adapterVersion":"0.1.0","startedAt":"…",
  "sessionGeneration":2,"capabilities":{…},"attest":{ "cmdlineHash":"…","childOfPi":true } }
```

`auth_ok` carries the server side: `{serverId, protocol, minProtocol, resumedFrom}`.

## 5. Streaming out (direction: pi → browser)

The vocabulary is unchanged from the shipped bridge (it is proven — A.8) and maps 1:1 onto existing
`DriverEvent` names handled by `sessions.applyDriverEvent`:

| pi event | frame `ev` | payload | throttle |
|---|---|---|---|
| `message_start` | `message_start` | `liveMessageId`, `role` | none |
| `message_update` | `message_update` | **cumulative** `preview` snapshot (blocks, `rev`, ≤2 MiB, images stripped to `mimeType`) | 40 ms coalesced per message |
| `message_end` | `message_end` | final preview | none |
| `turn_end` | `turn_end` | `messageEntryId`, `toolResultEntryIds`, `liveMessageId` ← *the mapping that makes the preview collapse into the persisted row* | none |
| `tool_execution_start/update/end` | `tool_update` | tool state (`replace` policy: pi sends cumulative snapshots), args preview ≤8 KiB, output ≤1 MiB, `durationMs`, `parentToolCallId` | 80 ms coalesced per tool |
| `agent_start` / `agent_settled{aborted}` | same | phase transitions | none |
| `session_start{reason}` | `session_start` | `sessionId`, `sessionFile`, `sessionGeneration`, `cwd` | none |
| `session_info_changed`, `session_tree`, `model_select`, `thinking_level_select` | same | name / leaf / model / thinking | none |
| `session_before_compact`, `session_compact`, `session_compact_failed` | `runtime_state{phase:"compacting"}`, `compacted`, `compact_failed` | | |
| `ui_prompt_start/end` | `dialog_observed`, `dialog_observed_end` | kind/title + "answer in the terminal" note | none |
| `input{source,streamingBehavior}` | `input_seen` | transparency only; the terminal is never fenced | none |

### 5.1 Ordering, replay, backpressure

* Every outbound frame carries a per-runtime monotonic `seq`; the server acks with `ping/pong`
  carrying `lastSeenSeq`.
* A bounded ring (`2000` frames / `4 MiB`, oldest dropped) serves §4's reconnect replay.
* Backpressure: if `socket.write()` returns `false` and the kernel buffer exceeds `4 MiB`, the hub
  **drops `message_update` previews first** (worst case: the browser shows the settled text from the
  file), then tool-output updates, and never drops `agent_*`, `turn_end`, `session_*`, `res` or
  `operation` frames. Dropped counts surface in `ev: diag{droppedPreviews:N}` and in `/api/v1/runtimes`.
* Frame size caps stay: 8 MiB inbound per connection buffer, 2 MiB per preview, 1 MiB per tool state
  (matches `shared/src/constants.ts`).

### 5.2 Pull paths (the server asks, the extension answers)

`snapshot`, `tree`, `context`, `models`, `commands`, `stats-lite`, `hello` — same implementations as the
shipped bridge (`buildSnapshot`, `buildBridgeTree`, runtime `context` preview labelled
`kind:"runtime_preview"` with `unavailableFields`). Two changes: `snapshot` now **must** include
`capabilities` and `sessionId` (so `mergeOwnerSnapshot` can refresh them, fixing B-8), and
`buildSnapshot` must return an error frame instead of throwing when no ctx is bound yet.

### 5.3 Commands in (direction: browser → pi)

`handleCommand` keeps its shape, with three fixes: resolve `pi`/`ctx` **through the hub at call time**
(B-11), keep the `seenOps` dedup (at-least-once safety), and honour generation fencing:

```
prompt{delivery: start|steer|followUp, text, images?, expandCommands?}
   dedup opId → guard sessionGeneration == frame.sessionGeneration → busy policy
   busy && delivery==="start"   → error "busy"            (409 upstream: never silently queued)
   !busy && delivery==="steer"  → error "busy"            (nothing to steer)
   pi.sendUserMessage(content, { deliverAs, expandPromptTemplates: expandCommands === true })
abort      → ctx.abort(); completion arrives as agent_settled{aborted}
compact    → ctx.compact({customInstructions,onComplete,onError})
setModel   → ctx.modelRegistry.find(provider,modelId) → await pi.setModel(m) → false ⇒ "pi_command_failed"
setThinking→ pi.setThinkingLevel(level)
rename     → pi.setSessionName(name)  (name:null unsupported ⇒ 501, honest)
dialogRespond → 501 "answer in the terminal"   (P-9)
clearQueue    → 501
stopForTerminal → 501 "already in the terminal"
```

Every command result returns a small, secret-free receipt (the server sanitizes again). `expandCommands`
defaults to **false** (literal delivery); the browser exposes it only as an explicit opt-in, because
`pi.sendUserMessage("/x", {expandPromptTemplates:true})` dispatches extension commands.

## 6. Identity and generations (extension side)

| Identity | Lifetime | Where |
|---|---|---|
| `runtimeId` | **process** (survives `/new`, `/reload`, session switches) | hub, minted once |
| `procStart` = `floor(performance.timeOrigin)` | process | hub, attested by the server |
| `sessionId` (pi UUID) | session | `ctx.sessionManager.getSessionId()` (P-10) |
| `sessionGeneration` | session, `++` on every `session_start` | hub |
| `runtimeGeneration` (server side) | bumps per connection, i.e. per server restart / reconnect | server |
| `seq` | per runtime, monotonic across reconnections | hub ring |

6.4 **Double-load guard**: `globalThis.__piwebBridgeInstalled` — a second instance in the same process
attaches to the existing hub and does **not** open a second connection (fixes B-7); the server side
additionally refuses a second connection with the same `runtimeId` unless `procStart` differs.

## 7. Legacy coexistence

One release supports both transports so nobody mid-setup is stranded:

* `PIWEB_BRIDGE_MODE=both` (default) — dial the descriptor server(s) **and**, if
  `PIWEB_BRIDGE_TOKEN`+`PIWEB_BRIDGE_DIR` are present, also run the old registry listener exactly as
  today.
* `pi-web serve --bridge-mode dial|legacy|both|off`, plus `pi-web deprecate-bridge` to print a
  migration note. The legacy path is deleted in the release after (P5 of `04`).

## 8. What the user sees inside `pi`

```
footer status:  ● pi-web  ·  1 viewer  ·  k7Q2m9xa
/piweb          notify: "pi-web k7Q2m9xa: live · /abs/session.jsonl · 1 viewer · 0 dropped"
                notify: "pi-web bridge is not connected: no server descriptor at ~/.pi-web/bridge.json.
                         Start it with `pi-web` (or set PIWEB_DATA_DIR)."      ← only when not connected
```

Status is set via `ctx.ui.setStatus("pi-web", …)` and cleared on `session_shutdown`. Also
`pi.registerFlag("no-pi-web-bridge", …)` for per-invocation opt-out.

## 9. Limits and non-goals

* No dialogs answered from the browser (P-9), no queue contents, no slash expansion by default.
* No network listener (UDS only), no TLS, no remote hosts — remote use stays `ssh -L` +
  `pi-web serve --bind`, documented in `04` §open questions.
* No force-takeover of an unbridged session, no writing of session files, no provider calls,
  no `SessionManager.open()` on live originals.
* Not a read path: the browser still reads persisted entries through the isolated read worker. The
  bridge only carries live facts and commands.

## 10. Implementation shape

```
extensions/pi-web-bridge.js  (~700–850 lines, single file, node:net/fs/path/os/crypto/perf_hooks only)
  createHub()            singleton, ring, dedup, diag counters
  resolveServers(env)    §2.2 search order → [{socket, token, serverId, protocol}]
  attach(hub, pi)        bindInstance + all pi.on(...) wiring (idempotent per instance)
  connect(hub, server)   dial + auth + hello + resume + ping/pong + backpressure
  handleCommand(hub, cmd, args)   §5.3
  buildSnapshot / buildTree / buildContext (moved from the shipped bridge, unchanged semantics)
  describe()             for /piweb and /api/v1/runtimes diagnostics
```

Estimated effort: **4–5 days** including the unit tests (a fake `ExtensionAPI` drives instance
replacement and command paths without a real pi) and the pty smoke that drives a real TUI.
Compatibility target: pi 1.5.0 measured; pi ≥ 1.4 assumed until probed; version gate policy in `03` §8.
