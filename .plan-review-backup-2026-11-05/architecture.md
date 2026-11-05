# Architecture

Decisions: D-01 … D-12 in [README.md](README.md#decision-log-summary).

---

## The forcing functions

Four facts about pi drive every structural choice here. All are ✓ verified against the
installed 1.5.0 (evidence: [appendix_pi_facts.md](appendix_pi_facts.md)).

**F-1 — The session file is the only shared state bus.**
Sessions are append-only JSONL trees under `~/.pi/agent/sessions/--<path>--/<ts>_<id>.jsonl`
with no separate prompt/context store. Anything pi-web wants to know about a session it
either reads from that file or asks a live pi process for. There is no third option.

**F-2 — pi does not lock session files.**
`SessionManager` appends with bare `appendFileSync` ✓. pi *does* use `proper-lockfile`
for `auth.json`, `settings.json`, and `trust.json` ✓ — but **not** for sessions. So two
live processes on one session file is an unguarded scenario. This is the central
correctness problem of the design and the reason for [leases](session_management.md#the-single-writer-rule).

**F-3 — The leaf is positional on open.**
`_buildIndex()` walks all entries and leaves `leafId` = the last entry in file order ✓.
Therefore: whichever side wrote last is where the other side resumes. This is what makes
handoff natural — and what makes divergence silent unless we detect it.

**F-4 — Extensions run in-process with whoever loads them.**
pi loads user TypeScript extensions into its own process ✓. If pi-web embeds pi in the
API server, a hostile or buggy extension takes the server down (and has pi's file
permissions). This is the reason for the `agent-host` child process boundary in D-02.

Non-functional drivers: single trusted user, local-first, must survive refresh/reconnect,
must stay small enough that one person maintains it.

---

## System overview

```
┌─────────────────────────────── browser (one tab per view) ──────────────────────────────┐
│  React SPA · transcript renderer · composer · session rail · read-only file viewer      │
└───────▲──────────────────────────────────────────────────────────────▲───────────────────┘
        │ REST (commands, reads)                                        │ SSE (event stream)
        │ POST /api/v1/sessions/:id/messages …                          │ GET /api/v1/sessions/:id/events
┌───────┴──────────────────────────────────────────────────────────────┴───────────────────┐
│  LAYER 1 · api-server            Node 22 + Fastify + TypeBox        (never imports pi)   │
│  routes · auth/bind guard · request validation · SSE fan-out · static SPA hosting        │
│  session-store (pi-web.db: leases, prefs, allowlist) · fs-mirror (read-only tailer)      │
└───────┬──────────────────────────────────────────────────────────────────────────────────┘
        │ internal IPC (structured clone over MessagePort, NDJSON-framed if socketed)
┌───────▼──────────────────────────────────────────────────────────────────────────────────┐
│  LAYER 2 · agent-host (child process, 1–n)                     (the ONLY pi importer)    │
│  Driver interface ─┬─ SdkDriver          (default: createAgentSession + SessionManager)  │
│                    └─ RpcProcessDriver   (fallback: spawns `pi --mode rpc --session …`)  │
│  per-session supervisor · event normalizer · capability probe · disposal policy          │
└───────┬──────────────────────────────────────────────────────────────────────────────────┘
        │ in-process SDK calls + event subscription   |   (or stdin/stdout JSONL for RPC driver)
┌───────▼──────────────────────────────────────────────────────────────────────────────────┐
│  LAYER 3 · pi core (installed pi 1.5.0)                                                  │
│  agent loop · tools · models · extensions · skills · MCP · SessionManager                │
└───────┬──────────────────────────────────────────────────────────────────────────────────┘
        │ appendFileSync (writes)  |  read + fs.watch (mirror tail)
┌───────▼──────────────────────────────────────────────────────────────────────────────────┐
│  ~/.pi/agent/sessions/**/*.jsonl        ← shared with the pi CLI, the real source of truth│
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Counting the layers depends on how you count: the requirement is "distinct frontend,
backend, and API layers". Here that is **frontend** (browser), **API** (HTTP/SSE contract
in [api_spec.md](api_spec.md)), **backend services** split into `api-server` (stateless
protocol/transport) and `agent-host` (the pi-facing supervisor). The api/agent-host split
is what keeps F-4 from becoming a stability problem and keeps `pi` importable from exactly
one place.

---

## Layer 1: api-server

**Stack: Node 22 LTS minimum (installed: v26.12.1) + Fastify 5 + TypeBox.**

pi itself depends on `typebox@1.3.27` ✓, so using TypeBox for route schemas means one
validation vocabulary across the whole system and free `Model<T>` typing on both sides of
the wire.

| Concern | Design |
|---|---|
| Responsibility | HTTP surface, auth token check, bind-address guard, request validation, static SPA serving, SSE fan-out, lease bookkeeping, mirror tailing, health/metrics |
| Statelessness | Holds no conversation state. Every read either tails a file or asks agent-host. Restart = reconnect clients, no data migration |
| Concurrency ceiling | Configurable `maxAttachedSessions` (default `1`, see Q-05); excess attaches queue with a visible "waiting for pi" state |
| Dependency rule | **MUST NOT** import `@earendil-works/pi-coding-agent`. Enforced by an ESLint `no-restricted-imports` path rule + a `check:boundaries` script |
| Rejected: Next.js | Prior art uses it ✓; it drags a full-stack router, server components, and a build pipeline into a local single-user tool, and blurs the API/backend/frontend separation the requirement explicitly asks for |
| Rejected: Express | Schema-less; more middleware surface for the same job |
| Rejected: Hono | Fine and lighter, but weaker story for compiled TypeBox validation + no first-class SSE backpressure idiom; Fastify's `reply.hijack()` is the cleanest SSE path |
| Rejected: Bun-only runtime | Bun 1.3.11 is available and attractive, but pi declares `engines.node >= 22.19.0` ✓ and the ecosystem assumption is Node; Bun MAY be supported later, not required |

**Why the mirror tail lives here, not in agent-host.** Watching a `.jsonl` file and parsing
appended lines is pure I/O: no pi code needed. Keeping it out of agent-host means a
mirror-only deployment (the safest mode, G-2) can run with **zero** pi processes
attached — pi-web then cannot affect a running CLI session at all.

## Layer 2: agent-host

The pi-facing supervisor. One process for the whole server by default
(`hosts: 1`); MAY shard to one host per workspace for isolation later.

**Responsibilities**

1. Load the capability probe at startup: pi version, presence of RPC commands and event
   types we rely on (list in [appendix_pi_facts.md](appendix_pi_facts.md#capability-probe)).
   Unknown version → warn + restrict to mirror mode (G-8).
2. Own `AgentSession` lifecycles: create/`switchSession`/`dispose`, and *only* dispose on
   lease loss, idle timeout (`60 s` default after last client, tunable), or shutdown.
3. Translate API-level commands into pi operations — the mapping table is normative and
   lives in [api_spec.md](api_spec.md#command-semantics).
4. Normalize pi's `AgentSessionEvent` stream into pi-web's wire events
   ([event_rendering.md](event_rendering.md)) including the documented delta
   reconstruction rules ✓.
5. Enforce the single-writer rule locally: refuse a second `SessionManager` handle on a
   file the host already holds, and refuse attach when the api-server lease is held by a
   mirror or another client.
6. Bound blast radius: uncaught extension throw → kill + restart that host, mark owned
   sessions `stale`, let clients reconnect ([reliability.md](reliability.md)).

### Driver interface

```
Driver
  probe()                      -> { piVersion, capabilities[], warnings[] }
  openSession({sessionFile|cwd, model, thinkingLevel, tools}) -> Handle
  list(cwd|all)                -> SessionSummary[]
  handle.prompt(text, images?, streamingBehavior?) -> {disposition}
  handle.steer(text) / handle.followUp(text) / handle.abort()
  handle.getState() / handle.getMessages() / handle.getEntries(since?) / handle.getTree()
  handle.setModel / setThinkingLevel / compact / setSessionName / fork / clone / newSession
  handle.subscribe(cb) -> unsubscribe
  handle.dispose()
```

Two implementations behind that seam:

| | `SdkDriver` (default) | `RpcProcessDriver` (escape hatch) |
|---|---|---|
| How | `createAgentSession({cwd, sessionManager})` + `session.subscribe()` ✓ | `pi --mode rpc --session <path>` child; JSONL stdin/stdout ✓ |
| Latency | one function call | pipe round-trip + JSON framing |
| Streaming payload | cumulative `message` snapshots on `message_update` ✓ | delta-only wire records; `partial` removed ✓ |
| Extension crash | kills the host (isolated by this process boundary) | kills one child, host survives |
| Project trust | resolves in-process; non-interactive path applies `defaultProjectTrust` ✓ | same non-interactive rule; MAY pass `--approve`/`--no-approve` ✓ |
| Isolation | none beyond the process | MAY run under different uid/container |
| Chosen for | v1 default (D-02) | Q-02 escape hatch (D-03) |

The delta-vs-cumulative difference between drivers is exactly the kind of divergence that
would break the renderer if it leaked. The normalizer's job is to erase it: pi-web's wire
events are **delta-only + authoritative `message_end`**, regardless of driver
([event_rendering.md](event_rendering.md#normalization-rules)).

## Layer 3: browser frontend

**Stack: Vite 7 + React 19 + TypeScript 5.x strict. Tailwind 4 with tokens generated from
pi's theme JSON. Zustand for client state. marked + DOMPurify for markdown, shiki lazily
for code. No component library (D-08).**

| Concern | Design |
|---|---|
| State | One store slice per session view: `entriesById`, `childIds`, `leafId`, `streamBuffer`, `queue`, `lease`, `connection`, `selection` |
| Event ingestion | Reducer fed by SSE; every action idempotent, keyed by entry id ✓ (see rules R-1…R-9 in [event_rendering.md](event_rendering.md#reducer-rules)) |
| Rendering | Windowed transcript (custom virtualizer; the only structural unit is a row) |
| Reconnect | Native `EventSource` semantics: send `Last-Event-ID` = last entry id; server replays from `get_entries(since)` ✓ |
| Rejected: Redux/TanStack Query | Reducer here is small and hand-written (rule tables are the spec); Query would cache server state that must never outlive its authority window |
| Rejected: WebSocket transport | See [api_spec.md](api_spec.md#why-sse-not-websocket) |
| Rejected: Monaco/CodeMirror | N-3: no editor |
| Rejected: xterm.js | N-1/D-11: no terminal |
| Rejected: shadcn/MUI/AntD | Chat-kit aesthetics fight G-5; the look is borders + type + spacing, not components |

---

## Data flow walkthroughs

### A. Open an existing session (read-only first paint)

```
browser            api-server                 agent-host                pi core
  │ GET /sessions/:id                          (mirror path, no host)   
  ├─▶ resolve file → parse JSONL (streaming)  fs.watch(file)
  │◀─ { entries[], leafId, projection }       (SessionManager semantics reimplemented
  │                                            read-only for cold open ✓)
  ├─▶ EventSource /sessions/:id/events?since=<leafId>
  │◀─ snapshot + heartbeat
```
The cold open uses a **read-only re-implementation** of pi's documented context-building
rules ✓ (`buildContextEntries` → `buildSessionProjection` → `buildSessionContext`) rather
than importing pi — that reimplementation is a named risk (R-06) with a conformance test
against pi's own exported functions in the test suite only.

### B. Attach and prompt

```
browser            api-server                    agent-host                 pi core
  ├─▶ POST /sessions/:id/lease  (acquire|renew)
  │◀─ { token, ttl }                     check no mirror conflict
  ├─▶ POST /sessions/:id/messages {text, mode:"replace"|"steer"|"followUp", idemKey}
  │                             ── IPC ──▶ handle.prompt(text, streamingBehavior)
  │                                        ─────────────────────────────────▶ prompt accepted
  │◀── 202 { disposition:"started" } ◀─────────────────────────────────────
  │◀══ SSE: agent_start, turn_start, message_start(assistant), message_update(text_delta)…
  │        tool_execution_start/update/end … message_end … turn_end … agent_end … agent_settled ✓
  ├─ (user types mid-run) POST /messages {mode:"steer"}  → handle.steer ✓
```

`agent_settled` — not `agent_end` — is the "pi will not continue automatically" signal ✓,
and is what flips the UI out of streaming state.

### C. Reconnect after network drop

Browser lost connection after entry `a1b2c3d4`. `EventSource` reconnects with
`Last-Event-ID: a1b2c3d4`; api-server asks the driver for `get_entries(since=a1b2c3d4)` ✓
and replays, then resumes live. If the cursor id no longer exists (file rewritten), the
server replies `X-Piweb-Resync: snapshot` and the client rebuilds from a full snapshot.

### D. Handoff terminal → browser

```
1. Terminal: user stops pi (Ctrl-C /exit). pi flushes; process gone.
2. Browser: session card shows "closed in terminal · openable" (mtime quiet + no lease).
3. User clicks Take control → POST /lease {force:true} → attach → prompt.
```
If step 1 did not happen (CLI still live), the lease acquisition checks the external-change
detector first: file grew within `quietWindowMs` → respond `409 conflict` with
`{lastSeenEntry, mirrorSuggested:true}` → UI offers **mirror instead** ([session_management.md](session_management.md#takeover-and-conflict)).

---

## Internal contract between api-server and agent-host

Single message envelope, one JSON object per frame:

```
{ "id": "...", "kind": "command|event|reply|control", "sessionKey": "...", "payload": {...} }
```

| Aspect | Rule |
|---|---|
| Transport v1 | `child_process.fork` with `stdio: [ignore, ignore, pipe, ipc]`; control over `node:ipc`, bulk events over the stdout pipe (NDJSON, LF-only framing — matching pi's own framing discipline ✓) |
| Ordering | Host serializes per-session commands; concurrent sessions independent |
| Backpressure | Host must not enqueue unbounded events for a slow api-server; on queue > `5 000` frames it coalesces deltas and, if still behind, sends `resync_required` (client then re-reads via cursor) |
| Liveness | `control:ping` every `5 s`; missed 3 → host considered dead |
| Death | api-server marks owned sessions `stale`, releases their leases, notifies clients with `pi-host-exited` |
| Shutdown | SIGTERM → host aborts active runs (`session.dispose()` ✓ semantics), flushes session, exits within `5 s`, then SIGKILL |

## Repo layout

```
pi-web/
├── plan/                      # this document set
├── package.json               # npm workspaces: client, server, shared, e2e
├── packages/
│   ├── shared/                # TypeBox schemas + wire types (single source for both sides)
│   │   └── src/{api,events,session,palette}.ts
│   ├── server/                # api-server + agent-host (only package depending on pi)
│   │   └── src/
│   │       ├── index.ts           # entry: npx pi-web
│   │       ├── api/               # Fastify routes, one file per resource
│   │       ├── sse/               # fan-out, Last-Event-ID, heartbeat
│   │       ├── mirror/            # JSONL tailer + read-only projection
│   │       ├── store/             # piweb.db (leases, prefs, allowlist)
│   │       ├── host/              # agent-host entry, supervisor, IPC
│   │       └── drivers/           # sdk-driver.ts, rpc-driver.ts, normalizer.ts
│   └── client/
│       └── src/
│           ├── views/{rail,transcript,composer,panel,settings}/
│           ├── state/             # store + reducers (event_rendering.md)
│           ├── render/            # entry→view transforms, markdown, diff
│           └── styles/            # tokens.css (generated), base.css
├── scripts/
│   ├── gen-palette.ts         # pi dark.json/light.json → tokens.css   (visual_design.md)
│   └── verify-pi.ts           # re-runs every ✓ claim in this plan      (appendix)
├── fixtures/sessions/         # synthetic .jsonl corpus incl. compaction/tree/edits
└── e2e/                       # Playwright: spawn real pi, drive real files
```

Dependency direction is one-way: `client → shared`, `server → shared`, `server/drivers → pi`.
Nothing imports `server`. `client` never sees a pi type.

## Deployment topologies

| ID | Where | Bind | Auth | Notes |
|---|---|---|---|---|
| T-1 | Same machine (default) | `127.0.0.1:4319` | token in first-visit URL → httpOnly cookie | `npx pi-web`; the primary path |
| T-2 | Tailnet, phone/laptop | `tailscale0:4319` | token **+** Tailscale identity header optional | HTTPS terminated by tailnet; documented recipe, no custom TLS |
| T-3 | Container | `0.0.0.0:4319` inside | token, **never** exposed without a reverse proxy | `/app` mounts workspace + `~/.pi/agent/sessions` read-write; the honest caveat is that a container that can write sessions can also run them |
| T-4 | Remote SSH port-forward | `127.0.0.1` on the laptop | none needed | zero config; the fallback for everything else |

Port `4319` chosen arbitrarily but fixed for docs; `--port` overrides. Non-loopback bind
MUST require an explicit `--host` flag plus a printed warning ([security.md](security.md#network-exposure)).

## Compatibility with pi upgrades

pi is a moving dependency, so:

1. **Pin** the tested pi version in `devDependencies` + record it in `piweb.lock.json`;
   at runtime, `probe()` compares.
2. **Capability-gate** features rather than version-gate: each endpoint declares required
   capabilities (e.g. `rpc.get_entries_since` ✓, `event.agent_settled` ✓, `event.context_edit` ✓).
   Missing capability → feature returns `501 {requiredCapability}` and the UI hides the control.
3. **Forward tolerance**: unknown entry types and unknown event types render as raw JSON
   nodes, never throw (G-9, rule R-9).
4. **Contract snapshot tests**: the entry-type and event tables copied into
   [appendix_pi_facts.md](appendix_pi_facts.md) are asserted by a test that regenerates them
   from the installed package; a diff fails CI and forces a plan update.
