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
                      ┌────────────── browser (React) ──────────────┐
                      │  REST (commands/control/snapshot) + SSE     │
                      └───────────────┬─────────────────────────────┘
                                  pi-web server
                 ┌──────────────────────┼───────────────────────┐
        read worker (read-only)     StreamHub (SSE)         drivers
                 │                      │            ┌─────────┴─────────┐
      session .jsonl files        replay/resync   bridge socket      managed IPC
                 ▲                                   ▲                 ▲
                 │                                   │                 │
        terminal `pi` (TUI)              terminal `pi` (TUI)     pi SDK child
        NO bridge = mirror only          WITH bridge = live      created in browser
```

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

## 10. Why it so often shows "mirror only" anyway

The mechanism works — adoption is what fails. Evidence and fixes in
`plan/terminal_live_control_plan.md`; in short:

1. **`install-bridge` installs a file Pi never loads.** pi 1.5.0 auto-discovers only
   `~/.pi/agent/extensions/*.ts|*.js`; pi-web copies `pi-web-bridge.mjs`. Renamed to `.js` it loads
   and registers within about a second of Pi finishing startup. (`pi -e <path>` accepts either name — which is why the manual
   workaround appears to work.)
2. **Nothing persists the bridge config.** Without `PIWEB_BRIDGE_TOKEN`/`PIWEB_BRIDGE_DIR` in the
   Pi process environment the bridge disables itself with a `console.error` you cannot see inside a
   TUI; the server only accepts records in `<dataDir>/bridges` whose `tokenHash` matches its own
   token. Any other dir/token — including the `e2e` "PyTUI" pty harness — is invisible.
3. **Identity is path-based.** A bridged session that has no file yet becomes a pathless
   `b_<runtimeId>` record while the file scan creates a mirror twin for the same conversation
   (observed: `mirror,live` listed for one session).
4. **Session switches break control.** The bridge closes its own endpoint on
   `session_shutdown{new,resume,fork,reload}`; after `/new` the terminal ends up non-controllable
   with a stale duplicate in the sidebar.
5. **Nothing says why.** No diagnostics endpoint, no UI explanation, no event that tells an open tab
   "a controllable runtime just appeared" (the client refreshes its list only on boot/login/create).

Already proven good, so no redesign is needed: **hot handoff without restart** — install the bridge as
`.js`, type `/reload` at the idle terminal prompt, and the session flips to `live` in ~3.3 s and
accepts browser prompts. With matching config, attach took 3.1 s and full control (start/steer/
followUp/rename/abort) worked against the same PID.

## 11. Making your terminal session bidirectional today

**The one hard rule:** to join a live terminal Pi mid-session, the bridge must be *inside that Pi
process*. Stock Pi offers exactly three supported injection points: `pi -e <path>`, the
`extensions` list in `~/.pi/agent/settings.json`, and auto-discovered
`~/.pi/agent/extensions/*.js|*.ts`. There is no fourth: a Pi started with none of them can only ever
be a file mirror (see §2 for why a mirror cannot stream), and there is no supported way to attach to
an already-running process from outside.

All three recipes below were run and measured (pi 1.5.0, stock pi-web, `--model mock/mock-echo`).
Every one of them still needs the bridge **token in the pi process environment** — stock pi-web has
no file fallback for it (`PIWEB_BRIDGE_TOKEN`/`PIWEB_BRIDGE_DIR` only), which is what plan P0 fixes.

```bash
# helper: ask the running server what it expects (never hardcode the token)
piweb_bridge() { piweb print-bridge-command --data-dir ~/.pi-web; }
# prints e.g.  PIWEB_BRIDGE_TOKEN=… PIWEB_BRIDGE_DIR=…/bridges pi -e …/bridge/extension.mjs
```

### R1 — per-terminal, zero footprint (nothing written to `~/.pi`) · measured: live in 2.9 s

```bash
pipi() {                     # put this in YOUR shell rc, not in any pi file
  local line tok dir ext
  line="$(piweb_bridge)"
  tok="$(printf '%s' "$line" | tr ' ' '\n' | sed -n 's/^PIWEB_BRIDGE_TOKEN=//p')"
  dir="$(printf '%s' "$line" | tr ' ' '\n' | sed -n 's/^PIWEB_BRIDGE_DIR=//p')"
  ext="$(printf '%s' "$line" | sed -n 's/.*-e //p')"
  PIWEB_BRIDGE_TOKEN="$tok" PIWEB_BRIDGE_DIR="$dir" pi -e "$ext" "$@"
}
```

`pipi` starts a stock Pi that carries the bridge (`-e` accepts the shipped `.mjs` name). Result:
listed `live` after 2.9 s, `preview=17` frames during a terminal turn, browser prompt `202 accepted`
and executed by that same PID.

### R2 — every future terminal Pi auto-carries it · measured: live in 1.8 s

```bash
mkdir -p ~/.pi-web/bridge
cp "$(piweb_bridge | sed -n 's/.*-e //p')" ~/.pi-web/bridge/pi-web-bridge.js   # .js on purpose
export PIWEB_BRIDGE_TOKEN="$(piweb_bridge | tr ' ' '\n' | sed -n 's/^PIWEB_BRIDGE_TOKEN=//p')"  # in your rc
```

Then add to `~/.pi/agent/settings.json` (configuration, not a code change):

```json
{ "extensions": ["/home/YOU/.pi-web/bridge/pi-web-bridge.js"] }
```

Verified with that exact settings entry: new Pi sessions came up `live` in 1.8 s with the extensions
directory untouched. (A `.mjs` target from `settings.json` was inconclusive in testing; keep the
`.js` copy.) Serving with `--data-dir ~/.pi-web` also makes `PIWEB_BRIDGE_DIR` unnecessary because
the bridge default is `~/.pi-web/bridges`.

### R3 — join a Pi that is **already running** with none of the above · measured: joined in 1.5 s

Do R2 (any install point works, including dropping the file into `~/.pi/agent/extensions/`), then
press **`/reload`** once at the idle terminal prompt. Nothing is lost: the Pi keeps its conversation,
the bridge loads, and the session flips mirror → live by itself.

```
before /reload:  modes = history, history        (file mirror only, no control)
+1.5 s:          mode  = live                   (preview=17 for the next terminal turn)
browser prompt:  202 accepted, echoed in the terminal
```

### Web side

```bash
piweb serve --data-dir ~/.pi-web        # prints a one-use login code
piweb allow /absolute/path/to/project   # so unbridged sessions of that cwd are listed at all
```

Open the printed URL, paste the code, pick the session (badge `L` + pid), click to take control.

### Still true on stock builds

* After `/new`, `/resume` or `/fork` the bridge closes its endpoint (§10.4): press `/reload` once, or
  just start the next session from `pipi`/R2 so the new process carries it from the start.
* Terminal dialogs are answered in the terminal only (§9).
* A session whose Pi was started with no injection point at all cannot be joined live — mirror only.

## 12. Security boundary (unchanged by making this easier)

* Unix socket only — the bridge opens **no** network listener; dir `0700`, record and socket `0600`.
* Every connection must present the shared token (constant-time compare); the record stores only its
  SHA-256; the server additionally validates `runtimeId`, `pid`, `procStart`, record uid/mode, and
  that `socketPath` lies inside the registry dir.
* Extension code runs inside your Pi process with your permissions, so installing the bridge is a
  consent act and stays an explicit command (`install-bridge`/`uninstall-bridge`, plus a planned
  `PIWEB_BRIDGE_DISABLE` kill switch and token rotation).
* Read paths are a separate worker restricted to allowlisted roots; nothing is scanned by default.
* Commands are validated against versioned schemas before they reach Pi; GETs stay side-effect free.

## 13. Quick reference

**Routes (all under `/api/v1`, auth required):** `GET /health` · `GET /meta` · `GET /capabilities` ·
`GET|POST|DELETE /workspaces[/:key]` · `GET|POST /sessions` · `GET /sessions/:key` ·
`GET /sessions/:key/entries[/:entryId]` · `GET /sessions/:key/tree|context|stats|raw|models|commands`
· `GET|POST /sessions/:key/control` · `POST /sessions/:key/commands` ·
`GET /operations/:operationId` · `GET /files` · `GET /sessions/:key/events` (SSE).

**SSE frame names:** `snapshot, entry, preview, runtimeState, toolState, queueState, dialogRequest,
dialogResolved, operationState, controlState, ownerChanged, conflict, resync, heartbeat, hostExited,
streamEnd, unknown`.

**Error → HTTP:** `invalid_request 400 · unauthorized 401 · forbidden 403 · not_found 404 ·
busy/owner_conflict/idempotency_conflict 409 · cursor_expired 410 · stale_control 412 ·
payload_too_large 413 · read_only 423 · capacity 429 · unsupported_capability 501 ·
pi_command_failed 502 · host_unavailable 503 · timeout 504`.

**Tunables:** `CONTROL_TTL_MS 30s` · `CONTROL_RENEW_MS 10s (unused)` · `DISPATCH_ACK_TIMEOUT_MS 10s`
· `HEALTH_PING_MS 5s` / `HEALTH_MAX_MISSES 3` · `MAX_MANAGED_RUNTIMES 4` ·
`SETTLED_HOST_CLEANUP_MS 60s` · `MAX_FILE_MIRROR_VIEWS 8` · bridge discovery sweep `3s`.

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
