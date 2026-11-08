# Terminal-session live control: investigation and implementation plan

Status: proposal for approval · Date: 2026-11-07 · Author: pi (research pass)
Target: remove the "mirror only" restriction for sessions started in a terminal Pi (the TUI,
including the `e2e/lib/ptyrun.py` "PyTUI" harness), so the browser sees live thinking/tool
streaming and can submit prompts, steer, abort and reconfigure that same runtime.
Background reading on the mechanisms themselves: `bidirectional.md` (repo root).

---

## 1. What "mirror only" is, in code

| Mode | Derived from | State | Control |
| --- | --- | --- | --- |
| `managed` | `SessionRec.kind==="managed"` + live `ManagedHandle` | runtime | yes |
| `live` | any `rec.driver` (bridge or managed) | runtime | yes |
| `mirror` | `!rec.driver && rec.file.exists` | `unavailable` | **no** |
| `history` | `!rec.driver && !rec.file.exists` | `unavailable` | **no** |

`sessions.ts:mode()` → `if (!rec.driver) return rec.file.exists ? "mirror" : "history"`.
`commands.ts:dispatch()` first gate → `if (!rec.driver) throw ApiError("read_only", …)`
(HTTP 423). `sessions.ts:capabilities()` returns the all-false "none" capability set with the
note *"No owning runtime: persisted file mirror only; runtime state is unavailable, not idle."*
The client disables the composer when `capabilities.canControl` is false
(`client/src/store.ts:215`, `App.tsx:329`).

So the *only* thing that separates a controllable terminal session from a mirror is
**`rec.driver` being set**, i.e. the server having adopted a live Pi runtime for that file.

## 2. Evidence (measured on this machine, pi 1.5.0, mock provider, isolated homes)

Scripts: `/tmp/repro/final2.mts`, `/tmp/repro/streamprobe.mts`, `/tmp/repro/handoff3.mts`
(reports in `/tmp/repro/report*.md`). Every row below was observed, not inferred.

| # | Observation | Result |
| --- | --- | --- |
| E1 | `piweb install-bridge` copies `pi-web-bridge.mjs` into `~/.pi/agent/extensions/`. pi 1.5.0 auto-discovery accepts only `.ts`/`.js` (`pi-coding-agent/dist/core/extensions/loader.js:585` `isExtensionFile`). | `.mjs` installed → **no bridge, no registry record**; renamed to `.js` → loads, records appear. Silent: pi reports nothing. |
| E2 | Bridge via explicit `pi -e <path>` | both `.mjs` and `.js` load → `-e` is not filtered; only auto-discovery is. |
| E3 | Bridge needs `PIWEB_BRIDGE_TOKEN` (+ optional `PIWEB_BRIDGE_DIR`) in the pi process env. Without it the bridge `console.error`s and disables itself — invisible inside the TUI. | no env → mirror forever |
| E4 | Server discovery: `BridgeDiscovery` scans **only** `cfg.dataDir/bridges`, requires `sha256(serverToken)` to match the record's `tokenHash`, mode 0600, uid match, socket inside the dir, and polls every **3 s**. | pi bridged into a foreign dir/token (exactly the `e2e/p0-capability-matrix.ts:316-322` layout) → invisible → mirror. Control on a mirror → `423 read_only` (measured). |
| E5 | Attach latency with matching dir/token (auto-discovered `.js`, no `-e`) | **3.1 s** from pi start to `mode:"live"` in the web API |
| E6 | Presence before the first message. Unbridged: pi writes **no JSONL at all** until the first append (measured: absent after 10 s idle; first record ~1.5 s after submitting a prompt). Bridged: the runtime reports the pre-allocated `sessionFile`/`sessionId`, so the session is listed immediately (`state=idle, entries=0`). | unbridged new session is invisible, not merely mirrored |
| E7 | Can a file mirror stream? During a 6 s streamed reply the file stayed byte-identical and only grew at message completion (`8472 → 8472 … → 9086 → 9700 → 10172`); SSE carried **no** `preview` frames. | mirror can never show token/thinking/tool streaming — the bytes do not exist until each record is complete |
| E8 | With bridge: SSE frames for one terminal-initiated turn containing a tool call | `preview=19 toolState=3 runtimeState=4 entry=3 operationState=1` |
| E9 | With bridge: web control. `control acquire → 200 epoch=1`; `prompt(start)`, `prompt(steer)`, `prompt(followUp)`, `rename`, `abort` → all **202 accepted**; the terminal echoed all three prompts; `operationState` updated 12×. | full bidirectional control already works |
| E10 | With bridge: `capabilities.canControl=true`, `livePreview=true`, `abort=true`, `dialogRespond=false` | terminal dialogs remain terminal-only (S-13b BLOCKED upstream) |
| E11 | Session switch: `/new` in a bridged terminal. The bridge closes its own endpoint on `session_shutdown{new,resume,fork,reload}`. Result: live rec went pathless (`live:NO-PATH`), a **duplicate** mirror rec appeared for the new file, and the terminal ended up **not controllable**. | broken handoff on session switch |
| E12 | Attach race: at connect time the file does not exist, so `attachBridge` creates a placeholder `b_<runtimeId>` with `path:null` while the file scan simultaneously creates a mirror rec → listed as `mirror,live` for one session. The placeholder only heals its path via a later snapshot merge; the DB row is never updated. | duplicate/split identity in the UI |
| E13 | Double load (auto-discovery **and** `-e`): two registry records, two sockets, one pid. `attachBridge` refuses the second (`duplicate owner refused`), and the server churns a connect per generation (`bridge_connected gen=1, gen=2`). | noisy, and one instance ends up orphaned |
| E14 | `Sessions.mergeOwnerSnapshot()` ignores `capabilities` from the owner snapshot; `BridgeHandle` captures `sessionFile`/`capabilities` at handshake only. | stale capability/session binding is never corrected |
| E15 | Client refreshes the session list on boot/login/create only (`store.ts:160`); nothing notifies "a new terminal session appeared". | a terminal session never shows up in an already-open tab |

**Bottom line.** The live path already works end-to-end (E8, E9). The "mirror only" symptom is
caused by adoption failures, not by missing control capability:

1. **RC1 (blocking, bug):** the shipped bridge artifact name (`.mjs`) is not auto-discoverable, and
   nothing persists the token/registry dir, so a normally-started `pi` never carries a bridge.
2. **RC2:** discovery is bound to one `dataDir` + one token with no supported configuration path;
   anything else (the PyTUI/e2e harness included) is invisible.
3. **RC3:** silent failure modes (extension not loaded; token missing; wrong dir; version pin) are
   reported nowhere a user can see.
4. **RC4:** identity/adoption defects — path-vs-sessionId dual identity (E12), no rebinding on
   session switch (E11), capabilities/`sessionFile` never refreshed (E14).
5. **RC5:** presence and list freshness: nothing exists before the first append (E6) and the client
   never learns that a runtime appeared (E15).
6. **RC6:** mirrors are structurally unable to stream (E7) — so the fix **must** be an in-process
   owner; no file-tailing trick can substitute.

## 3. Invariants we keep (do not trade these away)

From `plan/architecture.md`, `plan/session_management.md`, `plan/risks_and_open_questions.md`:

- Exactly one live Pi runtime per canonical session file; pi-web never writes session JSONL, never
  executes tools, never calls a provider.
- The terminal is never fenced: web grants arbitrate browser tabs only; local keyboard always wins.
- Public `ExtensionAPI`/`ExtensionContext` only — no monkey-patching, no `SessionManager.open()` on
  live originals, no debugger/CDP/gdb attach to a running terminal pi.
- Honest labelling: `unknown` ≠ `idle`, runtime preview ≠ exact provider context, unsupported
  capabilities return 501 rather than being simulated.
- Fail-closed Pi version pin (`TESTED_PI_VERSIONS=["1.5.0"]`) for all writes.
- Registry artifacts stay owner-only (`0700` dir, `0600` record, `0600` socket, token hash match,
  pid + procStart validation).

Accepted upstream limits (must stay visible in the UI): answering terminal extension dialogs from
the browser (S-13b BLOCKED), queue contents/clearing (flag only), slash-command and `@path`
expansion of web prompt text (literal delivery only).

## 4. Design decisions

**D1 — Install once, get adopted everywhere.** Replace "env vars on every launch" with a persisted,
user-consented installation:

- `piweb install-bridge` writes **`~/.pi/agent/extensions/pi-web-bridge.js`** (correct extension for
  auto-discovery, hot-reloadable via `/reload`) and **`~/.pi-web/bridge.json`** `0600`:
  `{version, serverId, dataDir, registryDir, token, piwebVersion, installedAt}`.
- Bridge resolution order inside the pi process:
  `PIWEB_BRIDGE_DISABLE=1` → off · `PIWEB_BRIDGE_TOKEN/DIR` env → win · else `bridge.json`.
- On missing/misconfigured token, report via `ctx.ui.notify(...)` at `session_start` (visible in the
  TUI) instead of `console.error`, once per process, with the exact fix command.
- `piweb uninstall-bridge` removes both files; a module-level `globalThis.__piwebBridgeInstalled`
  guard makes double loading (auto-discovery **and** `-e`) a no-op (fixes E13).
- `piweb install-bridge` also deletes a legacy `pi-web-bridge.mjs` and warns about `-e`-only setups.
- Consent is the single explicit command; README/SECURITY state plainly that after this, any pi you
  start in a terminal by this uid exposes a local, token-authenticated control socket to this server.

**D2 — Identity = pi session UUID, not path.** The v3 header carries `id` (verified:
`{"type":"session","version":3,"id":"01a1b6bf-…","cwd":…}`) and the read worker already extracts it
(`read/pure.ts:337` → `meta.piSessionId`), so no new parsing is needed. The bridge reports
`sessionId`+`sessionFile` even before the file exists. Index recs by `piSessionId`
(`Sessions.bySessionId`), fall back to canonical path for pre-v3/legacy files. `attachBridge`
adopts by `sessionId` first, path second, and creates the bridged rec **without** requiring
`fs.existsSync`. When the file later appears, the read-worker listing resolves to the existing rec
instead of creating a mirror twin (fixes E12, and half of E11). Persist `path`/`kind` updates to the
`sessions` table.

**D3 — One bridge endpoint per pi process, re-advertised on session switch.** Stop closing the
listener on `session_shutdown{new,resume,fork,reload}`. Instead: keep the socket, bump an internal
`sessionGeneration`, rewrite the registry record with the new `sessionId`/`sessionFile`, and emit
`session_start{sessionId, sessionFile, sessionGeneration}`. Fence commands issued against a stale
context by generation (return `session_generation_changed`). The server, on `session_start`,
re-keys the rec (merging any mirror twin), bumps the hub generation, and emits `ownerChanged` so an
open tab flips to the new session without a reload (fixes E11).

**D4 — Continuous re-advertising and capability refresh.** The bridge rewrites its record on
`session_start`, model/thinking/name changes and a 10 s heartbeat (already partly there).
`BridgeDiscovery` re-stats records each sweep; when `sessionFile`, `sessionId`, `capabilities` or
`protocol` changed, it re-reads the owner via `cmd("hello")` (new) and updates `BridgeHandle` +
`rec`; `mergeOwnerSnapshot` applies `capabilities` (fixes E14). Registry gains `protocol`
negotiation and an `adapterVersion`; unknown major protocol → refuse and surface `unsupported`.

**D5 — Fast, event-driven presence.** `BridgeDiscovery` additionally `fs.watch`es the registry dir
(150 ms debounce) on top of the 3 s sweep → attach ≈ 0.2–0.5 s. Add a server-wide stream
`GET /api/v1/events` (SSE) emitting `runtimeAttached`, `runtimeGone`, `sessionAppeared`,
`sessionRetired`, plus `GET /api/v1/runtimes` (pid, cwd, sessionId, sessionFile, piVersion,
protocol, caps, lastError) for the diagnostics panel; the client refreshes its list on those events
(fixes E15). Fallback if we want less surface: a 5 s conditional list poll while the tab is visible.

**D6 — Mirror stays honest, and explains itself.** Mirrors keep `state:"unavailable"` and never
invent phase. The UI gains a **Connect this terminal** flow for any mirror/history session: show the
detected cwd/workspace, the two commands (`piweb install-bridge`, then `/reload` at the idle prompt
or restart pi), a live "waiting for your terminal…" indicator driven by `/api/v1/events`, and a
`piweb doctor`-style reason when adoption is impossible (wrong server, unvalidated pi, conflict).
Composer for mirrors becomes the CTA instead of a dead input.

Rejected alternatives: attaching to a running pi via inspector/CDP or patching (breaks the
public-API rule and safety), letting pi-web spawn the user's terminal pi (cannot retroactively wrap
a TUI the user started; already covered by managed sessions), faking "live" from the JSONL tail
(E7 proves the data isn't there; would violate honest-state rules), and force-takeover of an
unbridged file into an SDK host (plan forbids: no proof the other writer exited; kept as the
explicit, evidence-gated P6 path).

## 5. Phased implementation

### P0 — Fix adoption (bug-fix slice, no protocol change) · ~1 day
| Task | File(s) |
| --- | --- |
| Ship bridge as `.js`; build emits `dist/bridge/pi-web-bridge.js` | `packages/pi-adapter/src/bridge/extension.mjs` → `extension.js`, `pi-adapter/package.json` build |
| `install-bridge` writes `.js` + `~/.pi-web/bridge.json` (0600), removes legacy `.mjs`, verifies by launching a probe pi and asserting a record | `packages/server/src/main.ts` (`install-bridge`, `print-bridge-command`) |
| Bridge reads `bridge.json` when env absent; `PIWEB_BRIDGE_DISABLE`; `globalThis` double-load guard; visible `ctx.ui.notify` on misconfiguration | `pi-adapter/src/bridge/extension.js` |
| `piweb doctor`: pi version/resolution, server reachability, bridge file + name check, bridge.json, live records, per-session "why mirror-only" verdict | new `packages/server/src/doctor.ts` + CLI |
| e2e/PyTUI harness uses the server's registry dir/token (or new `--bridge-dir/--bridge-token` server flags) so harness sessions are adoptable | `e2e/p0-capability-matrix.ts:316-326`, `e2e/server-smoke.mts` |
| README/SECURITY: 3-step terminal control section; state the consent/threat model | `README.md`, `SECURITY.md`, `docs/CHECKS.md` |

*Exit:* `piweb install-bridge` → start plain `pi` → session is `live` in the web UI within one
discovery sweep (measured 3.1 s; tightened in P3), thinking/tool streaming visible, web prompt
executed by the terminal pi. No env vars, no `-e`.

### P1 — Identity, dedupe, capability freshness · ~1–2 days
`Sessions.bySessionId` + `keyFor`/`ensureFromFile` reading the header id (read worker already
returns `meta.piSessionId`); rewrite `attachBridge` adopt-by-UUID-then-path, create-without-file,
persist path/kind; `cmd("hello")` in the bridge + `BridgeDiscovery` record-change revalidation;
apply `capabilities` in `mergeOwnerSnapshot`; regression test for the `mirror,live` twin (E12).

### P2 — Session-switch lifecycle · ~2 days
Bridge: remove endpoint teardown on `session_shutdown`, keep stable `runtimeId`, bump
`sessionGeneration`, re-advertise facts, gate commands by generation. Server: `session_start`
re-key + hub generation bump + `ownerChanged`; client auto-reacquire control on generation change
(`store.ts` already holds grants per key; add resync-on-ownerChanged). Cover `/new`, `/resume`,
`/fork`, `/reload`, and pi exit (artifacts still cleaned at process exit).

### P3 — Presence and latency · ~1 day
Registry `fs.watch` (+150 ms debounce) so attach stops depending on the 3 s sweep; `/api/v1/runtimes`;
global `/api/v1/events` SSE + client list refresh; mirror→live toast ("terminal connected · pid
12345"); attach budget p50 < 0.5 s, p95 < 1.5 s.

### P4 — UI for the handoff · ~1–2 days
Connect-this-terminal panel; honest capability notes surfaced next to disabled controls
(dialogs = answer in terminal; queue = pending flag only; prompts delivered literally);
runtimes panel + per-session adoption diagnostics; sidebar badges `L/M/H` with pid and since.

### P5 — Hardening, docs, matrix · ~1 day
Record `protocol` + `adapterVersion`; refuse unknown majors; max connections + per-conn rate limit
on the bridge socket; re-assert socket mode; token rotation `piweb rotate-bridge-token` (bridges
pick it up at next pi start; document); optional `PIWEB_BRIDGE_ALLOW_CWD` scoping; extend the
capability matrix (below) and regenerate `docs/CAPABILITY_MATRIX.md`.

### P6 — Optional, gated: promote a session whose terminal is gone
Evidence-based no-writer detection (`/proc/<pid>/cmdline`, fd scan over the file, mtime/idle) +
explicit user acknowledgement → open in a managed SDK host (existing machinery). Never automatic.
Kept out of the default flow; must disclose residual risk (plan R-01).

Effort total: ~6–9 engineering days; P0 alone removes the reported symptom for new sessions.

## 6. Verification plan (add to the matrix)

| ID | Scenario | Pass condition |
| --- | --- | --- |
| H-01 | `piweb install-bridge`, then plain `pi` (no env, no `-e`) | bridge record appears; web lists session `live` ≤ 2 s |
| H-02 | Legacy `pi-web-bridge.mjs` present | doctor/install detects and repairs; `doctor` exits non-zero until fixed |
| H-03 | No token, no `bridge.json` | TUI shows a visible notify with the fix command; session is `mirror` |
| H-04 | Terminal-initiated turn with thinking + tool call | SSE shows `preview>5`, `toolState≥1`, `runtimeState≥2` frames |
| H-05 | Web `prompt(start)/steer/followUp/abort/rename/setModel/setThinking` on a live bridge | each 202 → `operationState`; terminal echoes the text |
| H-06 | Mirror control attempt | `423 read_only` + UI shows Connect-this-terminal instead of a dead input |
| H-07 | `/new`, `/resume`, `/fork`, `/reload` while bridged | exactly one rec per pi session UUID, `live` again ≤ 2 s, no `NO-PATH` leftovers, no mirror twin |
| H-08 | Bridge in foreign dir/token (or wrong token) | session stays `mirror`; `/api/v1/runtimes` + doctor explain why |
| H-09 | Double load (`-e` + auto-discovery) | one socket/record per pid |
| H-10 | pi killed (`SIGKILL`) then restarted | stale artifacts cleaned; new runtime adopted; old grants return `stale_control` |
| H-11 | Two browser tabs + terminal simultaneously | one web controller; terminal still accepts input (S-10t parity) |
| H-12 | Attach latency | p50 < 0.5 s with watch, p95 < 1.5 s with poll fallback |
| H-13 | pi version not in `TESTED_PI_VERSIONS` | writes disabled (423 fail-closed) while mirror still renders |
| H-14 | Token rotation | old bridges stop being adopted after restart; doctor reports mismatch |

Unit tests: `bridgeConfig()` precedence; `bySessionId` adoption and twin suppression;
`mergeOwnerSnapshot` capability application; registry-record change detection. Smoke: extend
`e2e/server-smoke.mts` with H-01/H-04/H-05/H-07 against a real pty pi.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Every terminal pi now exposes a control endpoint (blast radius = same uid) | explicit one-time consent command; `0700/0600` artifacts, token auth, pid+procStart validation, `PIWEB_BRIDGE_DISABLE`, uninstall command, SECURITY.md threat model, optional cwd allowlist |
| Upgrading pi beyond the validated version silently disables control | `doctor` + UI banner naming the version gate; matrix H-13 keeps it honest |
| Session-switch re-keying could split history between recs | UUID-first identity + tests H-07 + generation fencing (no cross-generation command can land) |
| `fs.watch` misses events on exotic filesystems | keep the 3 s sweep as fallback; `doctor` reports stale records |
| Double-load leftovers in existing setups | global guard + install cleanup + H-09 |
| Terminal dialogs still unanswerable from the browser | unchanged: observation + explicit "answer in the terminal" UI copy, never auto-approval |
| PyTUI harness drift (temp dirs/tokens) | harness shares the server registry dir/token; `--bridge-dir/--bridge-token` flags make it explicit |

## 8. Definition of done for the request

A user starts `pi` in any terminal (or the PyTUI harness), types a prompt, and switches to the
browser: the session is listed within ~1 s as **live** (not mirror), shows thinking blocks, tool
calls and results streaming, and accepts prompts, steering, follow-ups, abort, rename, model and
thinking changes from the browser, while the terminal keeps working normally. Session switches
(`/new`, `/resume`, `/fork`, `/reload`) keep that property. When it is impossible (no bridge
installed, foreign server, unvalidated pi), the UI says exactly why and what to type.
