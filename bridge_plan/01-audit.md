# 01 — Audit: pi, pi-web, and the existing bridge

Everything below is either a `file:line` reference in this repo or in the installed pi 1.5.0
distribution, or a measurement from this machine (appendix §A). Nothing is inferred from docs alone
where a probe was possible.

> **Tree state.** The audit ran against the **working tree**, which was already dirty relative to
> `512e9a3` (52 modified/untracked paths — largely the client rebuild and the 2026-11-08 visual-audit
> fixes). A *different concurrent pi session* was also editing `packages/server/src/routes.ts`,
> `packages/shared/src/schemas.ts` and `packages/client/src/lib/store.ts` at 09:16 while this document
> was being written. Every `file:line` below was re-verified against the tree at 09:18 UTC; the cited
> symbols are stable, but treat line numbers as "as of 2026-11-08".

---

## 1. The system as it exists

```
                       browser (React, packages/client)
                     REST (commands · control · snapshot) + SSE
                                  │
                        pi-web server (packages/server)
        ┌────────────────────┬────┴─────────────┬──────────────────┐
   read worker          StreamHub           drivers          commands/control/ops
  (child proc,       (per-session ring,   ┌───┴────┐        (gates → SQLite op row
   allowlisted        epoch:seq, replay)  │        │         → 202 + operationState)
   roots, JSONL       idempotency,        bridge  managed
   only)              replay, resync      socket  IPC child
            ▲                ▲                ▲        ▲
    session .jsonl     session .jsonl   terminal pi   pi SDK child
    (any writer)       (tail, mirror)   + bridge ext  forked by pi-web
```

Three session topologies (`bidirectional.md` §1), one rule: **exactly one live pi runtime per
canonical session file**, and pi-web never writes session JSONL, never calls a provider, never runs a
tool. Every control action is a message to the runtime that already owns the session.

| Topology | `kind` | Runtime owner | Web mode | Control |
|---|---|---|---|---|
| bridged | `bridged` | the `pi` in a terminal + in-process bridge | `live` | yes |
| managed | `managed` | an SDK child pi-web forked | `managed` | yes (incl. dialogs) |
| discovered | `discovered` | unknown / none | `mirror` or `history` | **no** (`423 read_only`) |

The mode ladder is one function (`packages/server/src/sessions.ts:260`):

```ts
mode(rec) { if (!rec.driver) return rec.file.exists ? "mirror" : "history";
            return rec.kind === "managed" ? "managed" : "live"; }
```

and the write gate is the first line of `CommandDispatcher.dispatch()`
(`packages/server/src/commands.ts:97`): no `rec.driver` → `ApiError("read_only")` → HTTP 423.
Everything the UI disables derives from `capabilities.canControl`, which is `false` when there is no
driver (`sessions.ts:capabilities()`), and from `isReadOnlyMode()` in the client
(`packages/client/src/lib/labels.ts:21`). **So the only thing separating a mirror from a controllable
terminal session is `rec.driver` being set.**

## 2. pi 1.5.0 facts that constrain the design

| # | Fact | Source |
|---|---|---|
| P-1 | Extensions are auto-discovered from `~/.pi/agent/extensions/` (`*.ts`, `*.js`, `*/index.ts|js`, `*/package.json` with a `pi` manifest) and `.pi/extensions/` (project, after trust). **`.mjs` is not an extension file.** | `dist/core/extensions/loader.js:585` (`isExtensionFile`), `:630-665` (discovery rules); `docs/extensions.md` "Extension Locations" |
| P-2 | `settings.json → packages: ["npm:…","git:…","./path"]` is the supported distribution channel; `pi install npm:@scope/pkg` writes it and installs into `<agentDir>/npm`. Verified locally (§A.6): the entry appears in `settings.json` and the extension loads on the next pi start. | `dist/core/package-manager.js` (`getNpmInstallRoot` → `join(agentDir,"npm")`); `docs/packages.md`; §A.6 |
| P-3 | Pi retries a failing package install at start/`/reload`, and `-e npm:…` caches + version-checks. Offline mode (`PI_OFFLINE=1`) skips the check. | `docs/packages.md` |
| P-4 | Package rules: host-provided packages (`@earendil-works/pi-coding-agent` etc.) must be `peerDependencies: "*"`, **never** `dependencies` (a physical copy can duplicate registries). Node builtins and zero-dep extensions are always safe. | `docs/packages.md` "Declare dependencies" |
| P-5 | **Documented lifecycle rule:** extension factories may run in invocations that never start a session; *do not start sockets/watchers/timers from the factory* — defer to `session_start`, and close session-scoped resources in an idempotent `session_shutdown` handler. | `docs/extensions.md` "Long-lived resources and shutdown" |
| P-6 | On session replacement (`/new`, `/resume`, `/fork`) and on `/reload`, pi **creates a new extension instance**: `session_shutdown{reason}` → factory → `session_start{reason}` in the same pid. A `pi`/`ctx` captured by the old instance is stale and throws afterwards. | `docs/extensions.md` "Session replacement lifecycle and footguns"; measured §A.4, §A.5 |
| P-7 | `ctx.mode` is `"tui" | "rpc" | "json" | "print"` and `ctx.hasUI` says whether dialogs work — the clean gate for "bridge only the interactive TUI". | `dist/core/extensions/types.d.ts` (`ExtensionContext`), measured §A.3 |
| P-8 | `ctx.sessionManager` is a `ReadonlySessionManager` that includes `getSessionId()`, `getSessionFile()`, `getCwd()`, `getLeafId()`, `getEntries()`, `getTree()`, `buildContextEntries()`, `getHeader()`, `getSessionName()` — enough for identity and runtime previews without touching privates. | `dist/core/session-manager.d.ts:178` |
| P-9 | The write surface is exactly: `pi.sendUserMessage(content,{deliverAs,expandPromptTemplates})`, `pi.sendMessage`, `pi.setModel`, `pi.setThinkingLevel`, `pi.setSessionName`, `pi.appendEntry`, `ctx.abort()`, `ctx.compact({onComplete,onError})`, `ctx.ui.*`, `ctx.reload/newSession/fork/switchSession` (command contexts only). **There is no public API to answer another extension's TUI dialog** — `ui_prompt_start/end` carry `kind`/`title` only. | `dist/core/extensions/types.d.ts` (`ExtensionAPI`, `UIPromptStartEvent`); `bidirectional.md` §9 |
| P-10 | `session_start` fires with the session file **pre-allocated but not yet on disk**, and `sessionId` is the v3 header UUID. Measured §A.3: `fileExists:false`, `sessionId:01a1ba52-…`, `entries:2`. This is also what the read worker already extracts as `meta.piSessionId` (`packages/pi-adapter/src/read/pure.ts:424`). | §A.3 |
| P-11 | `PI_SESSION_FILE`/`PI_SESSION_ID` are **not** reliable in-process identity: a child pi inherits the parent's values (measured §A.2 — a nested `pi` reported the *outer* session file). Never use env for identity. | §A.2 |
| P-12 | Pi writes a session record only when the record is complete: during a 6 s streamed reply the file was byte-identical, then jumped (`8472 → 9086 → 9700 → 10172`); an unbridged new session has **no file** until the first append (~1.5 s after the first prompt). Live streaming therefore requires an in-process owner. | `bidirectional.md` §2 (E7); consistent with P-10 |
| P-13 | `Node v24.22.2` exposes **no** `getSocketCredentials`/`getPeerCredentials` on `net.Socket`, so `SO_PEERCRED` peer-uid verification is unavailable without a native addon. Measured §A.7. | §A.7 |

## 3. The existing bridge (`packages/pi-adapter/src/bridge/extension.mjs`, 632 lines)

What it does today, in order: reads `PIWEB_BRIDGE_DIR`/`PIWEB_BRIDGE_TOKEN` (module scope) → bails with
`console.error` if the token is missing or `< 16` chars → creates `runtimeId`, derives `procStart`
from `performance.timeOrigin`, picks `socketPath = <dir>/r-<runtimeId>.sock` → builds the preview/tool
state trackers → **`fs.mkdirSync` + `net.createServer().listen(socketPath)` at factory time**
(`:626`) → writes `<dir>/r-<runtimeId>.json` (`tokenHash`, pid, procStart, piVersion, sessionFile,
sessionId, capabilities) → wires ~20 pi events to `broadcast()` → registers `/piweb`.

Server side: `BridgeDiscovery` (`packages/server/src/drivers.ts:197-260`, poll interval at `:211`) scans only
`<cfg.dataDir>/bridges` every **3 s**, requires record mode exactly `0600`, record uid === server uid,
`socketPath` inside the dir, and `sha256(serverToken) === record.tokenHash`; then `BridgeHandle.connect`
dials, authenticates, and cross-checks `runtimeId`/`pid`/`procStart` **against the record the bridge
wrote**, i.e. the check is self-consistent rather than attested. Health = app-level ping every 5 s,
3 misses → dead. Commands are the JSONL `{t:"cmd",id,cmd,args}` protocol; the server side is
`CommandDispatcher`'s 11-gate gauntlet (`bidirectional.md` §4).

### What already works (do not redesign)

* Live event vocabulary and its merge into persisted entries: `turn_end.messageEntryId` maps a live
  preview onto the file entry id, and `readAppend` passes `replacesLiveMessageId` so the provisional
  row is replaced, never duplicated (`sessions.ts:findLiveMapping`, `readAppend`).
* The command gauntlet (schema → driver → conflict → version → generations → control grant →
  capability → operation reservation before dispatch → ack-vs-completion split → lifecycle promotion),
  with at-least-once semantics, `unknown`+`ambiguous` receipts and never-auto-resubmit
  (`commands.ts`, `operations.ts`, `bidirectional.md` §4,§7).
* Browser-tab arbitration (`ControlGrants`, 30 s TTL) that never fences the terminal, and the client's
  one transparent re-acquire+retry (`packages/client/src/lib/store.ts:command`).
* SSE transport with `epoch:seq`, bounded replay, `resync`, slow-consumer forced resync, ordering
  barrier `subscribe → snapshot → goLive` (`packages/server/src/hub.ts`).
* Bridged sessions bypass the workspace allowlist already: `visible()` returns true for
  `kind==="managed"|"bridged"` (`routes.ts:69`), so a bridged terminal session needs **no
  `pi-web allow`** to appear.
* Capability honesty: `queue:"flag"`, `dialogRespond:false` for a terminal, 501 instead of simulation.

### Defects (numbered for the plan)

| ID | Defect | Evidence |
|---|---|---|
| **B-1** | `pi-web install-bridge` copies to `~/.pi/agent/extensions/pi-web-bridge.mjs` (`main.ts:509-516`) — a name pi never auto-discovers (P-1). Silent: pi reports nothing. | E1 + `install-bridge` source |
| **B-2** | Config is env-only: `PIWEB_BRIDGE_TOKEN`/`PIWEB_BRIDGE_DIR` are read at module scope (`extension.mjs:25-26`) and nothing persists them; failure mode is `console.error` inside a TUI (`:34`). | E3 |
| **B-3** | Discovery is bound to one `<dataDir>/bridges` + one token, with the token stored only inside SQLite (`kv.bridge_token`, `auth.ts:104`), so it cannot be handed to another process without shelling into the server. Anything else (incl. the `e2e` pty harness at `e2e/p0-capability-matrix.ts:316-325`) is invisible. | E4 |
| **B-4** | `fs.mkdirSync` + `net.createServer` run at factory scope and `listen()` fires on module load — against the documented rule (P-5); it also leaks a socket/record for pi invocations that never start a session. | `extension.mjs:361-365`, `:626` |
| **B-5** | On `session_shutdown{new,resume,fork,reload}` it closes the listener and deletes artifacts (`:469-477`), so the terminal becomes un-controllable after `/new`, and a duplicate mirror twin appears for the new file. | E11 + §A.4 (instance replacement is the *cause*) |
| **B-6** | Identity is path-first: `attachBridge` needs `fs.existsSync(sessionFile)` else it invents a pathless `b_<runtimeId>` rec that is never persisted or healed (`main.ts:315-330`), while the file scan creates a mirror twin → `mirror,live` for one conversation. `sessions.byKey.get(handle.runtimeId)` in the `onGone` callback looks up the wrong key (`b_` prefix) — dead code. | E12 |
| **B-7** | Double load (`-e` **and** auto-discovery) creates two runtimes in one pid; the server refuses the second and churns a connect per generation. No idempotence guard. | E13 |
| **B-8** | `mergeOwnerSnapshot` ignores `capabilities`, `sessionId` and never persists a healed path for bridged recs; `BridgeHandle` captures `sessionFile`/`capabilities` at handshake only → permanently stale. | E14 |
| **B-9** | 3 s discovery poll is the only presence mechanism; nothing tells an open tab "a controllable runtime just appeared" (client refreshes the list on boot/login/create only) and nothing exists before the first file append. | E6, E15 |
| **B-10** | Fail-closed version pin `TESTED_PI_VERSIONS=["1.5.0"]` (`shared/src/constants.ts:77`) disables **all** writes on any other pi with no UI explanation, and `compat` is computed from the *server's* resolved pi when there is no driver. | `sessions.ts:compat()`, §9 of bidirectional.md |
| **B-11** | Prompt submission uses the `pi` object captured in the instance that created the socket; after a session switch that handle is stale and throws (measured §A.4). Any long-lived object holding `pi` must resolve it per-instance. | §A.4 |
| **B-12** | No replay/resume for the driver socket: a dropped connection forces a full `resync` + snapshot (tolerable, but the recovery is silent and costs a snapshot round-trip). | `drivers.ts:die("lost")` → `main.ts` onGone → `resync` |
| **B-13** | The server banner prints the **bridge token to stdout** (`main.ts:408`, printed at `:425`), which lands in shell history, CI logs and screen shares. | `main.ts` serve() banner |

## 4. Packaging / adoption findings

| ID | Finding |
|---|---|
| **K-1** | `npm i -g @piwebui/pi-web` (dist-tag `latest` = **0.1.0**) ships `bin: {"piweb": "./bin/pi-web.mjs"}` only → `zsh: command not found: pi-web` (`npm_fix/npm_install_error.md` is exactly this; the tarball *does* contain `bin/pi-web.mjs`, the manifest just doesn't name it). The repo has both names; it has never been published to `latest`. **Fix = cut a stable tag.** |
| **K-2** | The bridge artifact is shipped inside `@piwebui/pi-adapter` (`src/bridge/extension.mjs`; the tarball ships `src`, not `dist/bridge/`), and `bridgeExtensionPathFor()` walks `../../pi-adapter/src/...` relative to the server's `dist` — it works only because `files:["src","dist"]` and npm hoisting happen to cooperate. A first-party extension package removes this fragility. |
| **K-3** | `@piwebui/pi-web`'s dependencies include `tsx`, and the managed host + read worker are launched from `src/*.ts` when `dist` is absent — the new extension must not add any runtime dependency for the same reason (it must be loadable by pi's jiti with builtins only). |
| **K-4** | Release pipeline: canary to `next` per push, stable on tag, OIDC trusted publishing, and **the first publish of every new package is a manual step** (npm/cli#8544) — adding `@piwebui/pi-web-bridge` to the matrix has that one-time cost, and `scripts/package-smoke.ts` currently packs only `shared`, `pi-adapter`, `server`. |

## 5. Server-side facts the plan must respect (constraints, not defects)

* No login: an anonymous web session cookie is issued on the first API request; mutations still need
  `Origin` allow + double-submit CSRF (`packages/server/src/http.ts`), Host allowlist blocks DNS
  rebinding, CSP `default-src 'self'`, no CORS for credentials.
* Reads go through a **separate worker process** restricted to registered roots; the API process never
  imports pi. Live facts come only from a driver. The bridge must not become a second read path.
* Sessions are keyed by opaque server keys (`s_…`, `b_…`); `sessionGeneration`, `runtimeGeneration`,
  `fileGeneration` (`g<dev>-<ino>-<size>`), `streamEpoch:seq` and pi's header `id` are five distinct
  identities — D-3 makes pi's `id` the primary join key.
* Foreign-writer detection is deliberately conservative (inode change/shrink → `conflict` + frozen
  writes, no auto-repair). Any adoption change must keep that behaviour.
* Fresh fixes that must not regress: `pi-web allow` picked up live (`reloadWorkspaces()`), client
  cursor paging, `olderAvailable`, `humaniseError` copy, control-grant renewal.

## 6. What the browser still cannot do from a terminal session (accepted upstream limits)

| Limit | Cause | Required UI honesty |
|---|---|---|
| Answer a terminal extension dialog from the browser | P-9 | show as observed, "answer in the terminal"; never auto-approve |
| Queue contents / clearing | no public API | `queue:"flag"`, `clearQueue` → 501 |
| Slash-command / `@path` expansion of browser text | no public expansion entry point | literal delivery by default; opt-in `expandPromptTemplates` (see `02` §5.3) |
| Exact provider request payload | hooks/routing deeper than the extension API | label runtime `context` as a preview |
| Attaching to a pi started with no injection point | nothing runs inside it | explain "this pi needs the bridge; install it and `/reload` once" |

---

# Appendix A — measurements (this machine, 2026-11-08, pi 1.5.0, Node 24.22.2, mock provider)

Harness: `python3 e2e/lib/ptyrun.py` driving a real TUI pi with an isolated `PI_CODING_AGENT_DIR` and
the repo's local mock provider (`e2e/lib/mock-provider.ts` via `mockModelsJson`). Probe sources:
`/tmp/probe/ext2.mjs`, `/tmp/probe/ext3.mjs`, `/tmp/probe/run3.mts`, `/tmp/probe/cred2.mjs`,
`/tmp/probe/cred3.mjs`.

**A.1 — `session_start` on a fresh TUI pi (probe ext, `-e`):**
```json
{"k":"session_start","reason":"startup","mode":"tui","hasUI":true,
 "sessionFile":"…/2026-11-08T08-42-39-428Z_01a1ba52-edc3-….jsonl","fileExists":false,
 "sessionId":"01a1ba52-edc3-7606-939d-fbcda7d42051","entries":2}
```
→ identity and path exist before the file does (supports D-3, P-10). Mid-stream probe:
`fileExists:true` at the 3rd `message_update`; 5 `message_update` events for `[tokens:6]`.

**A.2 — env-based identity is unreliable:** a nested `pi -p` inherited
`PI_SESSION_FILE=/home/dev/.pi/agent/sessions/--home-dev-piwebui--/…08-08-39-840Z_01a1ba33….jsonl`
and `PI_SESSION_ID=01a1ba33-…`, i.e. the *parent* session (P-11).

**A.3 — session replacement re-instantiates the extension (same pid, same `globalThis`):**
```
events: factory/42f2483e, socket_listening, session_start:startup/42f2483e, settled,
        session_shutdown:new/42f2483e, factory/42f2483e, session_start:new/42f2483e, settled
AFTER /new: {"reason":"new","gToken":"42f2483e","pid":710958,
             "sessionId":"01a1ba53-acf3-…","sessionFile":"…08-43-28-371Z_01a1ba53-acf3-….jsonl"}
```
(the `gToken` is a `globalThis` singleton created in the first factory run and still identical).

**A.4 — a socket opened by instance 1 keeps serving after `/new`, and the refreshed handle works:**
```
RPC after /new (socket kept open across the switch):
  {"gToken":"42f2483e","pid":710958,"sessionId":"01a1ba53-acf3-…","idle":true}
RPC prompt dispatch after /new:  {"…":"…","sent":true}
settled after web prompt: true
```
And the negative control: with the same handler calling the **old** instance's `pi.sendUserMessage`,
the command never answered (the stale handle threw) — the origin of B-11.

**A.5 — `/new` observed with the *shipped* bridge** reproduces E11 (endpoint torn down, new runtime id,
terminal no longer controllable) — consistent with B-5.

**A.6 — `pi install <dir>` is a working, zero-config distribution path:**
```
$ PI_CODING_AGENT_DIR=/tmp/probe/home4 pi install /tmp/probe/pkg
Installed /tmp/probe/pkg
$ cat /tmp/probe/home4/settings.json
{ "packages": [ "../pkg" ] }
$ <next pi run>            → /tmp/probe/pkg.log: LOADED from file:///tmp/probe/pkg/extensions/pi-web-bridge.js
```
(the probe package declared `"pi": { "extensions": ["./extensions/pi-web-bridge.js"] }`).

**A.7 — no peer credentials from Node:** `net` server socket → `c.getSocketCredentials` is
`"undefined"`, `c.getPeerCredentials` likewise; the call throws `is not a function`. Trust model must
be token + file modes + process attestation (D-6).

**A.8 — carried over from the 2026-11-07 measurement pass** (`bidirectional.md`,
`plan/terminal_live_control_plan.md` §2): live bridged turn = `preview=19 toolState=3 runtimeState=4
entry=3 operationState=1`; `prompt(start|steer|followUp)`/`rename`/`abort` → `202 accepted`, echoed in
the terminal; mirror during a 6 s reply = zero byte change, zero `preview` frames; attach with matching
dir/token = 3.1 s; `/reload` join = 1.5 s; the whole R1/R2/R3 recipe set was measured working — which
is the proof that only adoption is broken.
