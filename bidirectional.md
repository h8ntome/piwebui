# Bidirectional: how pi-web and Pi sessions talk to each other

This document explains the whole bidirectional story in one place: what "bidirectional" means here,
which mechanisms implement each direction, what is provably working, what silently fails today, and
what has to change. Companion: `plan/terminal_live_control_plan.md` (root causes + phased plan).
Numbers marked "measured" come from live runs on this machine (pi 1.5.0, isolated homes, mock
provider) on 2026-11-07; see §10 and the plan's evidence table.

**One sentence:** pi-web renders and relays; **Pi is the only runtime and the only writer of session
files.** "Bidirectional" therefore never means "the browser edits a session" — it means *the browser
talks to the one Pi process that already owns the session*, in both directions.

---

## 1. Three topologies, one rule

```
                      ┌────────────── browser (React) ───────────────┐
                      │  REST (commands/control/snapshot) + SSE      │
                      └───────────────┬──────────────────────────────┘
                                  pi-web server
                 ┌──────────────────────┬────────────────┬───────────────┐
        read worker (read-only)   StreamHub (SSE)    bridge listener   managed IPC
                 │                      │           (one unix socket)      ▲
                 │                      │                 ▲                │
        session .jsonl files            │      terminal `pi` dials IN  pi SDK child
        (tail, mirror)                  │      (the bridge extension)   created in browser
                                        │
                 terminal `pi` (TUI) — NO bridge = mirror only; WITH bridge = live
```

The bridge direction is deliberate: the terminal connects **out** to the server, so there is one
artifact (the server's own socket + descriptor) instead of one per pi, no stale records to expire,
and a server that starts later is still found.

| Topology | Who owns the Pi runtime | Session created in | Web can control? |
| --- | --- | --- | --- |
| **bridged** (`kind:"bridged"`) | the `pi` you run in a terminal, plus the opt-in bridge extension inside it | terminal | **yes** — `mode:"live"` |
| **managed** (`kind:"managed"`) | a `pi` SDK child process that pi-web forked | browser | **yes** — `mode:"managed"` |
| **discovered** (`kind:"discovered"`) | some Pi (or nothing) we cannot see | terminal / any tool | **no** — `mode:"mirror"` or `"history"` |

The rule that makes all of this safe: **exactly one live Pi runtime per canonical session file.**
pi-web never opens a second `SessionManager` on a file it did not create, never writes JSONL, never
calls a provider, never runs a tool. Every control action is a message to the runtime that already
owns the file.

## 2. The mode ladder

`Sessions.mode(rec)` (`packages/server/src/sessions.ts`):

```ts
if (!rec.driver) return rec.file.exists ? "mirror" : "history";
return rec.kind === "managed" ? "managed" : "live";
```

| Mode | Source of truth | State shown | Live tokens/thinking/tools | Prompt from browser |
| --- | --- | --- | --- | --- |
| `history` | persisted file, not even present/watched | `unavailable` | no | no (`423 read_only`) |
| `mirror` | tailed JSONL (complete records only) | `unavailable` (**never** guessed as idle) | **no, structurally** | no (`423 read_only`) |
| `live` | the bridge inside your terminal Pi + tailed JSONL | real phase (`idle`/`streaming`/`awaiting_dialog`/…) | **yes** | **yes** |
| `managed` | the SDK child pi-web owns + tailed JSONL | real phase | yes | yes |

Everything the UI disables derives from one boolean, `capabilities.canControl`, which is `false`
whenever `rec.driver` is `null`. The server-side gate is the first line of
`CommandDispatcher.dispatch()`:

```ts
if (!rec.driver) throw new ApiError("read_only", "No owning runtime for this … session; input
requires a live bridge or a managed host.");   // → HTTP 423
```

### Why a mirror can never stream (measured)

Pi appends a record **when that record is complete**. During a 6-second streamed reply the session
file did not change at all, then jumped in one step at message completion
(`8472 → 8472 … 9086 → 9700 → 10172` bytes). A brand-new terminal session has **no file on disk
until the first append** (verified: absent after 10 s idle; first record ~1.5 s after submitting a
prompt). Consequences:

* token-by-token text, thinking blocks and in-flight tool output **exist only inside the Pi
  process**;
* so live streaming requires an in-process owner (the bridge) — no file-tailing trick can fake it
  without inventing state, which the design forbids;
* an unbridged new session is *invisible* to the web UI until its first persisted record.

## 3. Direction 1 — terminal → web (observation)

Two independent feeds are merged per session.

**(a) The file mirror (always on, read-only).** `Sessions.startWatch()` polls `stat` every 500 ms
plus `fs.watch`, reads only newly appended bytes with an LF framer, decodes complete records only,
and emits `entry` frames with a stable `entryId`. It also detects file replacement and shrink and
then **freezes mutation** (`conflict` + `resync`) rather than guessing.

**(b) The runtime feed (only with a bridge or a managed host).** The bridge turns Pi extension
events into frames:

| Pi event | adapter event | web frame | notes |
| --- | --- | --- | --- |
| `message_start/update/end` | `message_start/update/end` | `preview` | cumulative snapshot, throttled 40 ms, ≤4 previews, ≤2 MiB each |
| `tool_execution_start/update/end` | `tool_update` | `toolState` | replace-by-default (bash sends cumulative snapshots), 80 ms throttle |
| `turn_end` | `turn_end` | `runtimeState` | carries `messageEntryId` → **live preview is mapped onto the persisted entry id**, so the provisional row is replaced, not duplicated |
| `agent_start` / `agent_settled` | same | `runtimeState` | phase transitions, `lastSettled{at,aborted}` |
| `model_select`, `thinking_level_select`, `session_info_changed`, `session_tree` | same | `runtimeState` | model/thinking/name/leaf without touching the file |
| `ui_prompt_start/end` | `dialog_observed(_end)` | `dialogRequest`/`dialogResolved` | observation only in a terminal (see §7) |
| `input` | `input_seen` | — | proves "the human typed in the terminal"; terminal is never fenced |

Measured on a real terminal turn containing a tool call:
`snapshot=1 runtimeState=4 preview=19 toolState=3 entry=3 operationState=1` — i.e. thinking text,
tool arguments, tool output and final text all arrive live.

**(c) Reconnect and honesty.** SSE carries `id: streamEpoch:seq`, a bounded replay window
(`SSE_MAX_FRAMES=5000`, `SSE_MAX_BYTES=8 MiB`), and a `resync` frame when the window is gone; the
client then refetches a `snapshot` (file page + owner snapshot + pending dialogs + generations). If
the owner vanishes, the session degrades to `mirror`/`history` and says so
(`hostExited` → "runtime exited; session is now a file mirror").

## 4. Direction 2 — web → terminal (control)

A command travels this exact gauntlet (`packages/server/src/commands.ts`):

```
POST /api/v1/sessions/:key/commands   (Idempotency-Key header required)
  1 schema validation (TypeBox, versioned)
  2 rec.driver must exist                        → else 423 read_only
  3 no unresolved file/ownership conflict        → else 423 read_only
  4 pi version in TESTED_PI_VERSIONS (fail-closed)→ else 423 read_only
  5 envelope.runtimeId / runtimeGeneration match  → else 412 stale_control
  6 envelope.sessionGeneration match              → else 412 stale_control
  7 control grant (epoch + secret) validated      → else 412 stale_control
  8 capability bit for this command                → else 501 unsupported_capability
  9 operation reserved in SQLite (before dispatch) → 202 { operationId, state:"accepted" }
 10 dispatched to the owner, fire-and-track; ack deadline ≠ completion (DISPATCH_ACK_TIMEOUT_MS=10s)
 11 lifecycle events promote the operation to dispatched → succeeded / failed / unknown
```

Command types: `prompt{delivery: start|steer|followUp, text, images?}`, `abort`, `compact`,
`setModel`, `setThinking`, `rename`, `dialogResponse`, `clearQueue`, `stopForTerminal`.

They map onto public Pi extension APIs inside the bridge — `pi.sendUserMessage(content,
{deliverAs})`, `ctx.abort()`, `ctx.compact({onComplete,onError})`, `pi.setModel()`,
`pi.setThinkingLevel()`, `pi.setSessionName()`, `ctx.sessionManager.getTree()/
buildContextEntries()`, `ctx.modelRegistry`, `ctx.getContextUsage()`. No monkey-patching, no private
dist imports.

Measured on a bridged terminal session (control grant acquired with `200`, epoch 1):

```
prompt(start)     202 {"operationId":"op-e2e-01","state":"accepted"}   → terminal echoed it
prompt(steer)     202                                                  → terminal echoed it
prompt(followUp)  202                                                  → terminal echoed it
rename            202
abort             202                          → agent_settled(aborted) observed
```

**Busy policy is honest:** starting a prompt while the session streams is rejected (`busy` → 409)
rather than silently queued; you must choose `steer` (requires a running run) or `followUp`.

## 5. Direction 3 — browser → terminal handback (managed sessions)

Browser-created sessions run in an owned SDK child. "Continue in the terminal" is
`stopForTerminal{mode:"settle"|"abort"}`: the host settles all work and queues, exits, the server
waits for the process to die, releases the file reservation, and only then offers the exact
shell-escaped `pi --session /abs/path/to/file.jsonl`. Releasing while running is never offered, and
`pi --continue` is never used as the handoff command (it can pick a different session).
The reverse — a headless runtime gaining the existing TUI view — does not exist; only the bridge
path gives you one runtime with two surfaces.

## 6. Control: who is allowed to speak

`ControlGrants` issues `{controllerId, epoch, secret, expiresAt}` per session key, TTL 30 s
(`CONTROL_TTL_MS`). This arbitrates **browser tabs against each other**, nothing else:

* many followers may watch; exactly one tab holds the grant;
* `acquire` fails with `409 busy` if another live tab holds it;
* every command re-validates epoch + secret hash at the server **and** generation at the owner;
* expiry never aborts a run; the next foreground tab reacquires;
* the client currently acquires on demand (when `canControl` appears) and does **one transparent
  re-acquire + retry** on `412 stale_control` (`store.ts`). `CONTROL_RENEW_MS=10s` exists as a
  constant but is not wired, so expect a grant to lapse after 30 s and be renewed on next use.
* **The terminal is never fenced.** Your keyboard in the terminal always works; Pi's own
  idle/steer/follow-up rules serialize simultaneous input.

## 7. Operations: at-least-once with no surprises

Each command becomes an operation row (`accepted → invoked/acked → dispatched → succeeded |
failed | cancelled | unknown`) with an idempotency key and a payload hash. Rules that matter:

* the row is written **before** dispatch, so a crash in between is recorded;
* a dispatch whose outcome is uncertain becomes **`unknown` with `ambiguous` receipt** and is
  **never auto-resubmitted** (side effects already ran);
* owner death converts everything unfinalized to `unknown` (`ownerLost`);
* duplicate `operationId` is deduplicated **inside the bridge too** (`seenOps`), so a retry cannot
  double-prompt;
* replays of the same key with a different payload → `409 idempotency_conflict`.

## 8. Fences, generations, conflicts

| Identity | Owner | Invalidated by |
| --- | --- | --- |
| `sessionKey` (`s_…`, `b_…`) | pi-web (opaque, stable per rec) | session replacement can re-key (see §10) |
| `runtimeId` + `runtimeGeneration` | the bridge/child process | `/reload`, `/new`, restart |
| `sessionGeneration` | pi-web, bumped on `session_start` | session switch on the same runtime |
| `fileGeneration` (`g<dev>-<ino>-<size>`) | the JSONL file | truncate/replace/shrink → `conflict` |
| `streamEpoch:seq` | StreamHub per session key | reconnect/resync |
| pi `sessionId` (UUID in the v3 header) | Pi | the stable identity we should key on (see plan D2) |

Foreign-writer detection is deliberately conservative: inode change, shrink, or an unexpected record
id triggers `conflict` + frozen mutations and **no automatic repair, merge or rerun**. A quiet mtime
or a settled last entry is *not* proof that another writer exited, which is why force-takeover of an
unbridged file is not a feature.

## 9. What a terminal bridge cannot do (accepted limits)

| Limit | Why | UI consequence |
| --- | --- | --- |
| Answering terminal extension dialogs from the browser | Pi 1.5.0's public TUI extension events (`ui_prompt_start/end`) carry kind/title only, no response handle | dialog is shown as observed, "answer in the terminal"; never auto-approved. Managed (SDK) dialogs **are** answerable (`dialogRespond: true`). |
| Queue contents / clearing | not exposed by the extension API | `queue: "flag"` (has-pending only), `clearQueue` → 501 |
| Slash commands / `@path` expansion of browser text | no public expansion entry point | web prompts are delivered literally (documented in `capabilities.notes`) |
| Exact provider request payload | hooks/routing live deeper | `context` returns a `runtime_preview`, labelled as such |
| Unvalidated Pi versions | fail-closed pin `TESTED_PI_VERSIONS=["1.5.0"]` | reads keep working, all writes → 423 |

## 10. How the bridge connects (and why it no longer fails silently)

The transport was redesigned in the 1.0 cycle; `bridge_plan/` holds the audit and the design,
`packages/pi-extension/README.md` the user-facing version. In one paragraph: **the terminal dials
pi-web.** `pi-web serve` publishes `~/.pi-web/bridge.json` (`0600` — socket path + shared token)
and listens on `bridge-<serverId>.sock`; the extension in each `pi` resolves that descriptor,
connects, authenticates, and is then *attested* (the claimed `pid` must be a live Pi CLI that
started when it claims). Identity is pi's `sessionId`, so a session that has no file yet is adopted
as `live` rather than becoming a pathless placeholder with a mirror twin. The socket belongs to the
process, not to an extension instance, so `/new`, `/resume`, `/fork` and `/reload` re-bind the live
`pi`/`ctx` handles without dropping the connection.

What each of the historical failure modes became:

| Was | Now |
| --- | --- |
| `install-bridge` copied a `.mjs` pi never loads | `pi install npm:@piwebui/pi-web-bridge` (a real pi package), or `pi-web install-extension`, which copies `.js` and deletes any legacy `.mjs` |
| token/dir had to be in the pi environment, failure was `console.error` in a TUI | the descriptor file is the handoff; the reason nothing is connected is in `/piweb`, the `● pi-web` footer status, `pi-web doctor` and `/api/v1/bridge/diagnose` |
| path-first identity, `b_<runtimeId>` placeholders, mirror twins | `sessionId`-first adoption (`bySessionId`), twin merge, path healed when the file appears |
| endpoint torn down on session replacement | hub singleton: sockets survive, generations bump, the old row retires to `mirror` (readable, never hijacked) and a new live row is adopted |
| double load (`-e` *and* the package) made two runtimes | `globalThis` singleton on the bridge side, `duplicate_runtime` refusal on the server side |
| capabilities/sessionFile captured once, then stale forever | `snapshot` answers `capabilities` + `sessionId` + `sessionFile`, and adoption re-applies them |
| an open tab never learned a session became controllable | `GET /api/v1/events` (`runtimeAttached`, `sessionAppeared`, …) and the client refetches its list by itself |
| fail-closed version gate with no explanation | still fail-closed, but `compat.detail`, `/api/v1/capabilities`, `doctor` and the sidebar all name `PIWEB_ALLOW_PI_VERSIONS=<version>` |

## 11. Using it

```bash
pi install npm:@piwebui/pi-web-bridge      # once, ever — or: pi-web install-extension
pi-web                                     # prints the URL, publishes the descriptor
pi                                         # any project: listed `live` within ~2 s
```

Nothing else. No `PIWEB_*` variable has to be set in the `pi` process, no `piweb allow` is needed for
a bridged session (a terminal `pi` you started is your own consent), and a `pi` that was already
running when you installed the bridge joins by itself at its next `/reload` — or on the retry tick,
which is also what makes "pi started before pi-web" work (≤ 15 s).

In the terminal: `● pi-web · 1 viewer · <serverId>` in the footer, and `/piweb` prints the session,
viewers and dropped-frame counts — or the reason it is not connected. On the server side:
`pi-web doctor` (also `--json`), `GET /api/v1/runtimes`, `GET /api/v1/bridge/diagnose`.

Optional knobs, all on the bridge side: `PIWEB_BRIDGE_DISABLE=1`, `PIWEB_BRIDGE_FILE`,
`PIWEB_BRIDGE_MODES`, `PIWEB_BRIDGE_MAX_SERVERS`, `PIWEB_BRIDGE_DEBUG`, and the
`--no-pi-web-bridge` flag. On the server: `--bridge-mode dial|both|legacy|off`,
`--bridge-socket`, `--no-attest`, `bridge.allowCwd`, `bridge.autoTrust`,
`pi-web rotate-bridge-token`, `pi-web trust-runtime|revoke-runtime`.

The pre-1.0 transport (`PIWEB_BRIDGE_DIR` + `PIWEB_BRIDGE_TOKEN`, `<dataDir>/bridges` records, the
server dialling each pi) still works under `--bridge-mode both` for one release; when both a dial
connection and a legacy handle appear for the same pi, the dial connection wins and the legacy
handle is demoted rather than duplicating the session.

## 12. Security boundary of the bridge

* **Unix socket only.** The bridge adds no network listener; the HTTP port, Host allowlist, Origin
  allowlist, CSRF and CSP are untouched by it.
* One socket per server (`bridge-<serverId>.sock`, `0600`) inside a `0700` data dir, so two servers
  on one machine never fight and a stale socket is probed before it is taken over.
* The shared token lives only in `<dataDir>/bridge.json` (`0600`). It is never printed in the banner,
  logs, CLI output or an API response — `pi-web print-bridge-command` no longer even shows it.
* Every connection is gated in order: transport caps → token (constant time, 5 s) → identity →
  protocol range → **process attestation** → trust list, each rejection recorded with a machine-readable
  reason and counted in `/api/v1/bridge/diagnose`.
* Runtimes are recorded and revocable (`pi-web revoke-runtime`, `POST /api/v1/runtimes/:id/revoke`);
  `bridge.autoTrust=false` makes first contact require an explicit trust.
* **Same uid is the trust boundary**, and it is stated rather than glossed: Node exposes no
  `SO_PEERCRED` accessor, so peer uid cannot be verified from JavaScript. Anything running as you that
  can read `bridge.json` can register a runtime — which is the same set of things that can already type
  into your terminal. `PIWEB_BRIDGE_DISABLE=1` (or `--bridge-mode off`) turns it off completely.
* The extension uses only Pi's public extension API: no monkey-patching, no second writer of the
  session file, no provider calls, no debugger attach, and no answering of another extension's dialog
  (that limit is reported as 501 instead of simulated).

## 13. Quick reference

**Routes (all under `/api/v1`, auth required):** `GET /health` · `GET /meta` · `GET /capabilities` ·
`GET /runtimes` · `POST /runtimes/:runtimeId/revoke` · `GET /bridge/diagnose` · `GET /events` (SSE,
server-wide) · `GET|POST|DELETE /workspaces[/:key]` · `GET|POST /sessions` · `GET /sessions/:key` ·
`GET /sessions/:key/entries[/:entryId]` · `GET /sessions/:key/tree|context|stats|raw|models|commands`
· `GET|POST /sessions/:key/control` · `POST /sessions/:key/commands` ·
`GET /operations/:operationId` · `GET /files` · `GET /sessions/:key/events` (SSE).

**SSE frame names:** `snapshot, entry, preview, runtimeState, toolState, queueState, dialogRequest,
dialogResolved, operationState, controlState, ownerChanged, conflict, resync, heartbeat, hostExited,
streamEnd` — plus the machine-wide stream's `runtimeAttached, runtimeGone, sessionAppeared,
sessionRetired, bridgeDisabled`.

**Error → HTTP:** `invalid_request 400 · unauthorized 401 · forbidden 403 · not_found 404 ·
busy/owner_conflict/idempotency_conflict 409 · cursor_expired 410 · stale_control 412 ·
payload_too_large 413 · read_only 423 · capacity 429 · unsupported_capability 501 ·
pi_command_failed 502 · host_unavailable 503 · timeout 504`.

**Tunables:** `CONTROL_TTL_MS 30s` · `CONTROL_RENEW_MS 10s (unused)` · `DISPATCH_ACK_TIMEOUT_MS 10s`
· `HEALTH_PING_MS 5s` / `HEALTH_MAX_MISSES 3` · `MAX_MANAGED_RUNTIMES 4` ·
`SETTLED_HOST_CLEANUP_MS 60s` · `MAX_FILE_MIRROR_VIEWS 8` · bridge replay `2000 frames / 4 MiB` ·
bridge auth deadline `5s` · bridge conns `32`.

### Sequences

```
terminal turn, mirrored:            terminal turn, bridged:
pi ─append─▶ jsonl ─tail─▶ SSE entry  pi ─events─▶ bridge ─▶ SSE preview/toolState/runtimeState
(pi-web: read-only, no state)        (pi-web: phase, previews, leaf, queue flag)

browser prompts a bridged terminal:
tab ─POST /control acquire────▶ grant {epoch,secret}
tab ─POST /commands (env: runtimeId+gen, sessionGen, epoch, secret) ─▶ gates ─▶ op row ─▶ 202
server ─{t:cmd,prompt}─▶ bridge ─pi.sendUserMessage()─▶ same pi, same PID ─▶ run
server ◀─{t:ev, message_*/tool_*/agent_settled}──────┘   ─▶ SSE to every follower
```
