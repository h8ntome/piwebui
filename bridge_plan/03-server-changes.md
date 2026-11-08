# 03 — pi-web backend changes

Target: reliably **accept** bridge connections (D-1), adopt them with honest identity (D-3), and turn
their frames into the existing SSE/operation pipeline with no change to the safety model.

Nothing here changes the invariants: one live runtime per session file, pi-web never writes JSONL or
executes tools, the terminal is never fenced, honest `unknown` ≠ `idle`, unsupported → 501,
fail-closed on unproven pi versions.

---

## 1. `packages/shared`: one protocol module

New `src/bridge-protocol.ts`, exported from `src/index.ts`; `frames.ts`/`types.ts` stay as-is.

```ts
export const BRIDGE_PROTOCOL = 1;
export type BridgeFrame =
  | { t:"hello"; protocol:number; minProtocol:number; runtimeId:string; pid:number; procStart:number;
      sessionId:string; sessionFile:string|null; cwd:string; piVersion:string; piMode:"tui";
      adapterVersion:string; sessionGeneration:number; capabilities:Capabilities; attest?:{cmdlineHash:string} }
  | { t:"auth"; token:string; clientVersion?:string }
  | { t:"auth_ok"; serverId:string; protocol:number; resumedFrom:number|null }
  | { t:"auth_error"; code:string; message:string }
  | { t:"ev";  seq:number; name:string; payload:Record<string,unknown> }
  | { t:"cmd"; id:string; cmd:string; args?:unknown; sessionGeneration?:number; operationId?:string }
  | { t:"res"; id:string; ok:boolean; data?:unknown; error?:{code:string;message:string} }
  | { t:"ping"; id:string; lastSeenSeq?:number } | { t:"pong"; id:string; lastSeenSeq?:number }
  | { t:"replay"; fromSeq:number } ;
```

plus the descriptor type (`BridgeDescriptor`, §2), `RuntimeInfo` (for `/api/v1/runtimes`), the
capability bag (unchanged shape, so `Capabilities` in `types.ts` is reused verbatim), and the limits
(`BRIDGE_MAX_CONNS`, `BRIDGE_AUTH_TIMEOUT_MS=5000`, `BRIDGE_REPLAY_FRAMES=2000`, `BRIDGE_REPLAY_BYTES=4MiB`).

## 2. Descriptor + socket lifecycle (`packages/server/src/bridgeServer.ts`, new)

On `serve()` startup, before `app.listen`:

1. `mkdirSync(dataDir, 0o700)`, `mkdirSync(dataDir/servers, 0o700)`.
2. Resolve `serverId` (persisted `kv.server_id`), `bridgeToken` (`kv.bridge_token`).
3. Socket path `<dataDir>/bridge-<serverId>.sock`.
   * If it exists: try a `connect()` probe with a 200 ms deadline. Nothing answers **and**
     `descriptor.pid` is not alive ⇒ `unlink` and bind. Anything answers ⇒ fatal, one line:
     `pi-web: another server (pid N, serverId X) already owns <socket>; use a different --data-dir`.
     Per-server socket names mean two servers on one machine never fight.
4. `net.createServer(...)`, `listen`, `chmod 0600`.
5. Write `<dataDir>/bridge.json` atomically (`bridge.json.tmp` + `rename`, `0600`) with §2.1 fields;
   if `dataDir !== ~/.pi-web`, also write `~/.pi-web/servers/<serverId>.json` pointer.
6. On shutdown: close the listener, destroy conns, `unlink` socket, leave `bridge.json` (stale
   descriptors are detected by `pid`/`procStart` and by the failed connect).
7. `pi-web rotate-bridge-token`: new token → new descriptor → all live conns get `ev: reauth_required`
   and are dropped after 5 s so bridges reconnect with the new secret (documented restart semantics).

`PIWEB_BRIDGE_DISABLE=1` skips 3–5 and does not start the listener (the whole feature is then legacy
mode only).

## 3. Inbound conns: `BridgeConn implements Driver`

`BridgeHandle` (`drivers.ts:43-195`) already speaks this protocol in the client role; refactor the
framing/pending-map/health code into a shared `BridgeLink` and add the accepting role:

```ts
class BridgeServer {
  private conns = new Map<string, BridgeConn>();          // runtimeId → conn
  onAttach: (conn: BridgeConn, hello: Hello) => void;
  onGone:   (conn: BridgeConn, reason: "closed"|"timeout"|"revoked") => void;
}
class BridgeConn implements Driver {
  kind = "bridge"; runtimeId; generation; pid; piVersion; sessionFile; cwd; capabilities;
  sessionId; sessionGeneration; lastSeq;
  cmd(cmd, args, timeoutMs)   // identical semantics to BridgeHandle.cmd
  onEvent(cb) / onDead(cb) / dispose(reason) / alive()
}
```

Acceptance rules, in order, each failure logged with a machine-readable reason (surfaced by
`/api/v1/runtimes` and `pi-web doctor`):

| Gate | Rule |
|---|---|
| transport | only UDS, `0600` socket, `0700` dir; `MAX_CONNS=32`; per-conn inbound buffer 8 MiB; per-line 4 MiB; ≥ 20 frames/s sustained else shed (`diag.throttled++`) |
| auth | first frame must be `auth` with the token (constant-time compare) within 5 s; anything else = destroy |
| identity | `hello.runtimeId` unique; a second conn with the same `runtimeId` replaces the older one only if `procStart` differs, else `auth_error: duplicate_runtime` |
| **attestation (new)** | claimed `pid` must be alive **and** started at `procStart`: Linux → `/proc/<pid>/cmdline` contains `pi-coding-agent` (or argv[0] basename `pi`) and `/proc/<pid>/stat` start-time agrees within ±5 s; macOS/other → `ps -p <pid> -o etimes=` agrees within ±10 s. Failure = `auth_error: attest_failed` (config `bridge.requireAttestation`, default `true`; degrades to `pidAlive` with a logged warning where neither probe works) |
| protocol | `minProtocol ≤ BRIDGE_PROTOCOL ≤ protocol`, else `auth_error: unsupported_protocol` |
| trust | `runtimes.trusted` — auto-trust on first sight (same uid by construction, since the token is `0600`), with `bridge.autoTrust=false` to require `pi-web trust-runtime <runtimeId>` |
| version | recorded, not enforced here (see §8) |

The important property: `hello` claims are checked against **OS state the bridge cannot forge from
another uid**, which is strictly better than today's record-vs-hello self-comparison (B-8's root).

## 4. Adoption and identity (`packages/server/src/sessions.ts`, `main.ts`)

```ts
class Sessions {
  byKey   = new Map<string, SessionRec>();
  byPath  = new Map<string, SessionRec>();
  bySessionId = new Map<string, SessionRec>();   // NEW: pi UUID → rec  (D-3)
}
```

`attachBridge(conn, hello)` becomes:

```
rec = bySessionId.get(hello.sessionId)
   ?? (hello.sessionFile && byPath.get(realpath(hello.sessionFile)))
   ?? newRec(hello)                       // no fs.existsSync gate  (fixes E6/B-6)
if (rec.driver && rec.driver !== conn) → conn.dispose("duplicate owner refused")   // unchanged
key:  rec.key stays "s_…" if it exists, else "s_" + hash16(sessionId)               // persists
kind: "bridged"; meta.piSessionId = hello.sessionId; meta.path = hello.sessionFile
persist: INSERT … ON CONFLICT(key) DO UPDATE SET path, kind, pi_session_id, workspace_key
ensureWatch(rec) once the file appears
void conn.cmd("snapshot") → mergeOwnerSnapshot(rec, snap)  // now applies capabilities + sessionId (B-8)
hub.emit(rec.key,"ownerChanged",{runtime,mode}) ; hub.emit(rec.key,"resync",{reason:"owner_attached"})
globalHub.emit("runtimeAttached", {runtimeId, pid, sessionId, sessionKey: rec.key, cwd, piVersion})
globalHub.emit("sessionAppeared", {sessionKey: rec.key, mode:"live"})
```

`mergeOwnerSnapshot` additionally: applies `capabilities`, refreshes `conn.sessionFile`/`sessionId`,
and when a **mirror twin** exists for the same path/sessionId, merges the two recs (keep the bridged
one's key, retire the mirror key, emit `sessionRetired`) — this is the E12 twin fix, and it also heals
the case where the mirror was created first.

Two follow-on details that are easy to miss:

* **Read roots.** The isolated read worker rejects any file outside its registered roots
  (`packages/pi-adapter/src/read/worker.ts:29-33`, roots from `Sessions.sessionRoots()` =
  `<agentDir>/sessions` + configured extras). A bridged pi started with `--session-dir`, or under a
  different `PI_CODING_AGENT_DIR`, would therefore list but fail to page its entries. Fix:
  `sessionRoots()` also contributes the dirname of every attested bridged rec
  (`bridge.trustSessionDirs`, default `true`; `false` for a hardened setup, where the rec then reports
  `entries: unavailable` honestly instead of `forbidden`).
* **Both transports on one server** (`--bridge-mode both`): the dial connection wins. If a legacy
  registry handle attaches to a rec that already has (or later gets) a dial connection for the same
  `pid`, the legacy handle is disposed and logged as `bridge_mode_demoted`, so one pi never equals two
  drivers (today's `duplicate owner refused` guard, `main.ts:329-331`, reused).

### 4.1 Session switch (`ev: session_start{reason, sessionId, sessionFile, sessionGeneration}`)

```
if (hello/newSessionId === rec.meta.piSessionId && reason === "reload") {
    bump runtimeGeneration sentinel on the conn; hub.bumpGeneration; resync   // same session
} else {
    retire: rec.driver = null; ops.ownerLost(rec.key);
            mode → mirror (its file is still there, history preserved);
            hub.emit(rec.key,"ownerChanged",{runtime:null,mode:"mirror"});
    adopt:  attachBridge(conn) for the new sessionId  → new sessionKey
            globalHub.emit("sessionAppeared", …) ; if the browser was watching the retired rec,
            the client shows a toast "the terminal switched sessions" and offers the new one (no hijack).
}
```

This is the design point worth flagging for approval: a `/new` produces **a new session row**, it does
not re-key the row you were looking at. The old conversation stays readable (it is on disk), the new
one appears as live. E11's "stale duplicate + uncontrollable terminal" disappears.

### 4.2 Store migration (`packages/server/src/store.ts`)

```sql
ALTER TABLE sessions ADD COLUMN pi_session_id TEXT;         -- via the existing idempotent migrate()
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_piid ON sessions(pi_session_id) WHERE pi_session_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS runtimes(
  runtime_id TEXT PRIMARY KEY, server_id TEXT, pid INTEGER, proc_start INTEGER, cwd TEXT,
  pi_version TEXT, protocol INTEGER, adapter_version TEXT, caps TEXT,
  first_seen INTEGER, last_seen INTEGER, trusted INTEGER DEFAULT 1, last_error TEXT, dropped_frames INTEGER DEFAULT 0);
```

## 5. A second, server-wide stream (`packages/server/src/hub.ts`, `routes.ts`)

`StreamHub` gains a sibling instance for machine-wide facts (a `StreamHub` is already generic over a
key; the server-wide key is `"*"`):

| event | payload |
|---|---|
| `runtimeAttached` / `runtimeGone` | `{runtimeId, pid, serverId, reason?}` |
| `sessionAppeared` / `sessionRetired` | `{sessionKey, mode, cwd, piSessionId}` |
| `bridgeDisabled` | `{reason}` |

`GET /api/v1/events` (SSE, same cursor/heartbeat machinery) + existing per-session stream stay
independent. The client subscribes to `/events` for the lifetime of the tab and calls
`refreshSessions()` on `sessionAppeared`/`runtimeAttached` — fixing E15 (a terminal session that
appears while the tab is open now shows up by itself).

## 6. New and changed endpoints (`packages/server/src/routes.ts`)

| Route | Purpose |
|---|---|
| `GET /api/v1/runtimes` | live bridge + managed runtimes: `{runtimeId,pid,piVersion,protocol,adapter,cwd,sessions:[{key,piSessionId,mode}],caps,lastError,dropped}` — the diagnostics panel's data |
| `GET /api/v1/events` | server-wide SSE (§5) |
| `GET /api/v1/bridge/diagnose` | machine-readable doctor output: descriptor state, listener path/mode, token present, bridge counts, per-reason "why is this session a mirror", version-gate verdict, legacy-mode findings |
| `POST /api/v1/runtimes/:runtimeId/revoke` · `DELETE` | trust list mutation (also via CLI) |
| `GET /api/v1/sessions` | unchanged except that bridged recs are adopted by sessionId, so a fresh terminal session is listed even with **no file at all** |
| `GET /api/v1/health` | adds `bridges:{dial:n, legacy:n, listener:"ok"|"disabled"|reason, descriptorAgeMs}` |

No change to `POST /sessions/:key/commands` — the gauntlet is transport-agnostic because
`CommandDispatcher` only needs a `Driver`.

## 7. Client changes (minimum for the goal, details in `plan/ui_design.md` conventions)

1. `store.ts`: subscribe to `/api/v1/events`; `refreshSessions()` on `sessionAppeared`,
   `runtimeAttached`; on `ownerChanged` of the active rec, auto-reacquire the control grant (the grant
   is per `sessionKey`, and a switch creates a new key, so without this the composer is dead until the
   user clicks).
2. `Composer.tsx`: when `isReadOnlyMode(mode)`, replace the dead input with the **Connect this terminal**
   CTA panel: detected cwd, the two commands (`pi install npm:@piwebui/pi-web-bridge`, then `/reload`
   in that terminal if it was already running), and a live "waiting for your terminal…" indicator driven
   by `/api/v1/events` + `GET /api/v1/bridge/diagnose`.
3. Sidebar badges: `live` shows pid + `since` (from `/runtimes`), `mirror` shows the reason
   (`no bridge`, `pi 1.6.0 not validated`, `foreign server`, `file conflict`).
4. New Settings → **Runtimes** tab: the `/runtimes` table plus revoke buttons and the version-gate note.

## 8. Version gate, made loud instead of silent (B-10)

```ts
// shared: replace the hard pin with a policy the server can reason about
export const PI_VALIDATED_VERSIONS = ["1.5.0"];
export const PI_SUPPORTED_PROTOCOLS = [1];
```

`compat(rec)` uses the **driver's** `piVersion` when present (it already does) and, for
`live` recs on an unvalidated pi:

* writes stay `423 read_only` (fail-closed stays — this is a safety property),
* but `status.compat.detail` becomes actionable and the UI shows a banner with the exact escape hatch:
  `PIWEB_ALLOW_PI_VERSIONS=1.6.0`, and `pi-web doctor` prints the same line,
* `/api/v1/capabilities` reports `{pi:{version,tested,allowedByConfig}}`.

## 9. CLI changes (`packages/server/src/main.ts`)

| Command | Change |
|---|---|
| `pi-web` / `pi-web serve` | banner stops printing the token (B-13); prints `Terminal control: install once → pi install npm:@piwebui/pi-web-bridge` and `runtimes: 2 connected`; `--bridge-mode dial|legacy|both|off`, `--bridge-socket`, `--no-attest` |
| `pi-web install-extension` | new (replaces `install-bridge`): copy the `.js`, remove a legacy `.mjs`, print the `pi install` one-liner as the preferred path; `install-bridge` kept as an alias with a deprecation note |
| `pi-web doctor [--json]` | new `packages/server/src/doctor.ts`: pi presence/version, server reachable (`/health` via the descriptor's `http`), listener + descriptor perms/age, connected runtimes, per-session "why mirror", extension file check (name `.mjs`, both `-e` and package installed), version-gate verdict, legacy-mode leftovers it can clean |
| `pi-web rotate-bridge-token` | §2.7 |
| `pi-web trust-runtime <id>` / `revoke-runtime <id>` | trust list |
| `pi-web pair [--ttl 15m]` | prints `PIWEB_BRIDGE_FILE=… PIWEB_BRIDGE_TOKEN=…` for a *non-local* host (documentation aid for the `ssh -L` story, not zero-config) |

`serve()` also replaces the "PIWEB_BRIDGE_TOKEN=… pi -e …" block with the three-line zero-config
message, and `unknownFlags`/`KNOWN_FLAGS` gain the new flags.

## 10. Security review items to close together with this change

1. **Descriptor is a secret file.** `0600`/`0700`, never world-readable; `doctor` verifies modes and
   says so. Same-uid remains the trust boundary (P-13) and `SECURITY.md` must say it plainly: *a process
   running as your uid that can read `~/.pi-web/bridge.json` can register a fake runtime and push
   prompts into any pi it can name*. The new mitigations beyond today: attestation (§3), the runtime
   trust list with revocation, `PIWEB_BRIDGE_DISABLE`, and no token ever appearing in a banner, log
   line, or CLI stdout.
2. **Bridged sessions bypass the workspace allowlist** (`routes.ts:69`) — deliberate today, and now
   more reachable. Keep it (a terminal pi is the user's own consent), but require the connection to
   pass attestation before a rec is created without a file, and add the option
   `bridge.allowCwd: ["/abs/prefix"]` for people who want the old belt.
3. **Inbound listener DoS surface**: conn cap, per-conn rate cap, buffer caps, `auth` deadline, and
   `MAX_PREVIEWS`/`MAX_TOOL_STATE_BYTES` unchanged on the merge path (`sessions.ts:mergeOwnerSnapshot`
   replaces maps wholesale — keep the cap when applying `o.previews`).
4. **Command audit**: log `{ts, sessionKey, runtimeId, cmd.type, operationId, outcome}` (no payload
   bodies) to `<dataDir>/audit.jsonl`, `PIWEB_AUDIT=0` to disable. Prompts typed in a browser are user
   content; keep bodies out of logs, as everywhere else.
5. **No new network listener.** The bridge stays UDS-only; the HTTP port is untouched (Host allowlist,
   CSRF, CSP all unchanged).

## 11. Observability (server log events, all `logInfo` with structured fields)

`bridge_conn_accepted`, `bridge_conn_rejected{reason}`, `bridge_runtime_attached{runtimeId,pid,piVersion}`,
`bridge_runtime_gone{reason}`, `bridge_session_adopted{sessionKey,piSessionId}`,
`bridge_session_retired`, `bridge_twin_merged`, `bridge_attest_failed{claimed,found}`,
`bridge_backpressure{runtimeId,dropped}`, `bridge_replay{runtimeId,from,to}`,
`bridge_descriptor_written{path}`, `bridge_listener_error{code}`.

## 12. File-by-file change list

| File | Change | Est. |
|---|---|---|
| `packages/shared/src/bridge-protocol.ts` | new: frames, descriptor, limits, `RuntimeInfo` | 0.4 d |
| `packages/shared/src/types.ts`/`index.ts` | export additions; `Capabilities` unchanged | 0.1 d |
| `packages/pi-extension/**` | the extension (`02` §1–§10) | 4–5 d |
| `packages/server/src/bridgeServer.ts` | new: listener, accept gates, `BridgeConn` | 1.2 d |
| `packages/server/src/drivers.ts` | extract `BridgeLink`; keep `BridgeHandle` (legacy) and `ManagedHandle`; reuse health | 0.5 d |
| `packages/server/src/descriptor.ts` | new: descriptor/pointer write + rotate + read helpers (also used by `doctor` and tests) | 0.3 d |
| `packages/server/src/sessions.ts` | `bySessionId`, adoption, retirement/switch, twin merge, capability refresh, persist | 1 d |
| `packages/server/src/main.ts` | wiring, banner, CLI commands, flags | 0.7 d |
| `packages/server/src/routes.ts` | `/runtimes`, `/events`, `/bridge/diagnose`, health additions | 0.5 d |
| `packages/server/src/hub.ts` | global stream instance | 0.2 d |
| `packages/server/src/store.ts` | migration + `runtimes` table + trust helpers | 0.3 d |
| `packages/server/src/doctor.ts` | new | 0.6 d |
| `packages/server/src/auth.ts` | descriptor-aware `bridgeToken`, rotation, `bridge.*` config keys | 0.3 d |
| `packages/client/src/lib/store.ts`, `features/Composer.tsx`, `features/Sidebar.tsx`, `features/SettingsDialog.tsx` | global SSE, CTA, badges, Runtimes tab | 1.5–2 d |
| `packages/server/package.json`, `scripts/*`, `.github/workflows/release.yml`, `e2e/**` | publish + smoke + CI + harness switch to descriptor mode | 1 d |
| `README.md`, `SECURITY.md`, `docs/CHECKS.md`, `CHANGELOG.md`, `bidirectional.md` rewrite | user-facing truth | 0.7 d |

**Backend total ≈ 7–8 days** (excluding the extension itself); with the extension (4–5 d, `02` §10) and
the P0 relief slice (2 d, `04`), the full programme is **≈ 13–14 days**. `04` phases it so that the
user-visible symptom is gone after ≈ 2 days and the zero-config requirement is met after ≈ 8.5.

## 13. Sequences (post-change)

```
pi start                extension                     pi-web server
─────────────────       ───────────────────────       ───────────────────────────
session_start    ──▶    resolve descriptor (§2.2)
                       dial unix socket ──────────▶  gates: transport/auth/identity/attest/trust
                       hello{sessionId,sessionFile}  adopt rec by sessionId (no file needed)
                                                  ◀──  auth_ok{serverId,protocol}
                                                  ◀──  cmd snapshot → mergeOwnerSnapshot
                                                  ◀──  global: runtimeAttached, sessionAppeared
                                                          └─▶ browser tab refreshes list by itself
browser prompt         POST /commands ─▶ gaunt ─▶ op row ─▶ 202
                       cmd{prompt,operationId} ─▶ pi.sendUserMessage(via hub's live pi)
message_* / tool_* ──▶ ev{seq} ─▶ SSE preview/toolState ─▶ browser
turn_end{messageEntryId} ─▶ preview collapses into the persisted entry
/new                   session_shutdown{new} → factory → session_start{new}
                       sockets kept; hub re-bound     retire old rec → mirror
                       ev session_start{newSessionId} adopt new rec → live again, ≤ 1 s
```
