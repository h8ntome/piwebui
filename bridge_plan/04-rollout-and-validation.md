# 04 — Rollout, verification, risks

## Phases

Each phase ships behind the default-on flag described in `03` §7 of that doc, and each has an exit test
that a human can run in under two minutes.

### P0 — make the existing mechanism installable (kills the reported symptom) · ~2 d
No transport change yet; this is the "day one relief" slice.

* Publish a stable `0.1.1` so `latest` carries the **`pi-web` bin name** (K-1) — today's
  `npm_fix/npm_install_error.md` is exactly this.
* `pi-web install-extension`: `.js` (never `.mjs`), delete a legacy `pi-web-bridge.mjs`, no token
  handling (B-1).
* Bridge config resolution gains the **descriptor file** (still used only for the *legacy* token/dir),
  `PIWEB_BRIDGE_DISABLE`, the double-load guard, and `ctx.ui.notify` instead of `console.error`
  (B-2, B-7, RC3).
* Socket creation moves out of the factory into `session_start` (B-4).
* `pi-web doctor` v1 (pi, server, descriptor, bridge file, "why is this a mirror").
* e2e/PyTUI harness switches to the descriptor instead of hand-rolled temp dirs/tokens
  (`e2e/p0-capability-matrix.ts:316-325`).

*Exit:* `pi-web` running + `pi-web install-extension` + a **plain `pi`** (no env, no `-e`) → `live`
in the browser within one 3 s sweep; prompts land in that terminal.

### P1 — the new transport: extension dials the server · ~4 d
`02` §2–§4 and `03` §1–§3: `bridge-protocol.ts`, `descriptor.ts`, `bridgeServer.ts`, `BridgeConn`,
acceptance gates incl. process attestation, legacy mode coexisting (`--bridge-mode both`).

*Exit:* a pi with only `pi install npm:@piwebui/pi-web-bridge` connects to a server that starts
**after** it, within the retry cap (≤ 15 s), and to one that starts before it, within ~1 s.

### P2 — identity, adoption, session-switch continuity · ~2.5 d
`03` §4: `bySessionId`, adopt-without-file, twin merge, retire/adopt on `/new`·`/resume`·`/fork`,
`reload` = same rec, persistence, `mergeOwnerSnapshot` applies `capabilities` + `sessionId`.
Extension side: hub singleton + `hub.pi` refresh + `session_start` re-advertise (B-5, B-8, B-11).

*Exit:* the H-07 matrix row: after `/new`, `/resume`, `/fork`, `/reload` exactly one live rec per pi
`sessionId`, live again ≤ 1 s, no `NO-PATH` leftovers, no mirror twin, browser prompts still work.

### P3 — presence, latency, replay · ~1.5 d
Server-wide SSE `/api/v1/events` + `sessionAppeared`/`runtimeAttached`, `/api/v1/runtimes`, client
auto-refresh and auto-reacquire, per-runtime `seq` + bounded replay, backpressure policy.

*Exit:* open tab learns about a new terminal session by itself; attach p50 < 0.5 s, p95 < 1.5 s
(legacy 3 s sweep gone from the default path); a 3 s socket blip recovers by replay, not by resnapshot.

### P4 — the handoff UI · ~2 d
Connect-this-terminal CTA, honest per-session "why mirror" text, sidebar badges with pid, Runtimes
settings tab, revoke buttons, version-gate banner (§8 of `03`).

### P5 — hardening, deprecation, docs · ~1.5 d
`rotate-bridge-token`, trust list CLI, `bridge.allowCwd`, conn/rate caps + fuzz, capability-matrix
regeneration, SECURITY.md/README rewrite, `--bridge-mode legacy` warning, remove `BridgeDiscovery`
after one release with the telemetry line `bridges.legacy>0` observed at zero.

**Total ≈ 13–14 engineering days** (P0 2 + P1 4 + P2 2.5 + P3 1.5 + P4 2 + P5 1.5), of which the
extension itself is ~4–5. **P0 alone removes the reported symptom; P0+P1+P2 (≈ 8.5 d) is the point
where "install both packages and it just works" is literally true.**

## Definition of done (the request, restated as a test)

```bash
npm i -g @piwebui/pi-web                       # then, in another terminal:
pi install npm:@piwebui/pi-web-bridge
pi-web &                                       # prints URL; browser opens; no token printed
pi                                             # a plain, stock pi in any project dir
```
Within 2 s of pi's first `session_start`, and with **no** env vars, `pi -e`, `piweb allow` or restart:

1. `GET /api/v1/sessions` lists it with `mode:"live"`, `piSessionId` set, even **before** the JSONL exists;
2. a terminal turn with thinking + a tool call produces `preview ≥ 5`, `toolState ≥ 1`, `runtimeState ≥ 2`
   frames and the preview collapses into the persisted entry (`turn_end.messageEntryId`);
3. `prompt(start)`, then `prompt(steer)` while streaming, then `prompt(followUp)`, `rename`,
   `setThinking`, `setModel`, `abort` each return `202 accepted` and their `operationState` reaches
   `succeeded`/`dispatched`, and the text appears in the terminal;
4. the terminal keyboard still works the whole time;
5. `/new`, `/resume`, `/fork`, `/reload` leave 1–4 true;
6. `pi-web doctor` and `GET /api/v1/runtimes` explain any deviation in one sentence each.

## Verification matrix

| ID | Scenario | Pass |
|---|---|---|
| H-01 | descriptor written on serve, modes `0600`/`0700`, pointer for non-default `--data-dir` | `stat` checks + `doctor` ok |
| H-02 | plain `pi` after `pi install` (no env) | `live` ≤ 2 s; `bridges.dial ≥ 1` |
| H-03 | `pi` started **before** `pi-web` | connects ≤ 15 s after the server comes up, no pi restart |
| H-04 | server restart with a stale socket file | new server binds (probe-then-unlink) or refuses with the owner named |
| H-05 | wrong token (foreign descriptor) | `auth_error: unauthorized`, runtime not adopted, `doctor` reports it |
| H-06 | spoof: another process claims a pid that is not a live pi | `attest_failed`, logged, not adopted |
| H-07 | `/new`, `/resume`, `/fork`, `/reload` | one live rec per pi `sessionId`, live ≤ 1 s, old rec readable as mirror |
| H-08 | double load (`-e` **and** package) | one connection per pid (`duplicate_runtime`) |
| H-09 | `pi` SIGKILLed | conn EOF → rec → mirror; `runtimeGone`; in-flight ops → `unknown` |
| H-10 | streaming during a socket drop/reconnect | replay by `seq`, no duplicate previews, no lost `turn_end` |
| H-11 | browser prompt with images + `expandCommands` off | delivered literally; images survive (`ATT-01` mapping fix) |
| H-12 | huge tool output (10 MiB bash) | backpressure drops previews only; `dropped` counted in `/runtimes`; no pi slowdown > 1 % CPU |
| H-13 | 20 concurrent terminals + 100 mirrored sessions | attach ≤ 2 s each; server RSS growth < 150 MB; no 3 s sweep storm |
| H-14 | pi version not validated | writes `423`, banner + `doctor` name the override, reads keep working |
| H-15 | token rotation | old conns dropped, new ones adopted after the extension's retry; `doctor` explains mid-flight |
| H-16 | `PIWEB_BRIDGE_DISABLE=1` / `--bridge-mode off` | no listener, no connects, UI says "bridge disabled" |
| H-17 | two servers, one pi | pi connects to both; each browser can control (pi serialises); no record/socket collisions |
| H-18 | legacy `install-bridge` user (`.mjs` + env) | keeps working under `--bridge-mode both`; deprecation note appears |
| H-19 | `pi -p` / pi-subagents children / managed host | **no** bridge connections (mode gate) |
| H-20 | terminal dialog appears | browser shows observed dialog + "answer in the terminal", never auto-approves |
| H-21 | fresh `npm i -g` artifact (packed) | `pi-web doctor`, `install-extension`, `serve` all runnable from an unrelated cwd |
| H-22 | 60 s idle pi with an open browser tab | no CPU/wakeups from the bridge (timers unref'd, no polling below 15 s) |

Unit tests: descriptor resolution order and malformed input; frame codec + ring/replay; acceptance
gates (mock socket + fake `/proc` reader); adoption (`bySessionId`, twin merge); retire/adopt state
machine; command mapping with a fake `ExtensionAPI`; `doctor` verdicts. pty smoke: H-02/03/07/09/12
against a real TUI pi with the mock provider (harness already exists: `e2e/lib/ptyrun.py`).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Every terminal pi now holds an inbound-capable connection to a local listener (blast radius = your uid) | token + `0600` descriptor + process attestation + trust list + revocation + `PIWEB_BRIDGE_DISABLE` + per-invocation flag + SECURITY.md rewrite stating the boundary honestly (P-13: no peer-cred available, so this is the design, not an oversight) |
| A fake same-uid runtime could inject a session row (bridged recs skip the allowlist, `routes.ts:69`) | attestation before adopt, `bridge.allowCwd` option, `sessionAppeared` toast naming pid+cwd, revoke UI, audit log |
| Two transports live at once confuse support | one flag (`--bridge-mode`), `/health` reports both counts, `doctor` names the mode, legacy deleted after observing `bridges.legacy == 0` |
| pi API drift (1.6+) silently breaks control | protocol negotiation, capability probing instead of hardcoded pins, validated-version banner + `PIWEB_ALLOW_PI_VERSIONS`, CI matrix with pi pinned **and** pi@latest (advisory) |
| Session-switch re-keying splits history between rows | identity = pi `sessionId`, retire-to-mirror instead of re-key, H-07 |
| Replaying frames after a reconnect duplicates previews | monotonic per-runtime `seq` + server dedup by `(runtimeId,seq)`, `replaceKey` coalescing already in `hub.ts` |
| Backpressure hides content | documented drop policy (previews first), `dropped` counters visible in the runtimes panel and in `/piweb` |
| Retrying connectors hammer the machine | backoff cap 15 s + jitter, `fs.watch` fast path, `unref()`d timers, `MAX_SERVERS=4`, H-22 budget |
| Windows | UDS assumptions break; named pipes (`\\.\pipe\pi-web-<serverId>`) + DACL + same token, gated behind `os.platform()` — explicitly out of P0–P4 scope, tracked as F-1 in open questions, and the extension must fail silently (no crash) there |
| Inode-conflict safety regressions during adoption changes | keep `pollFile`/`conflict` logic untouched; adoption only *adds* a driver, it never relaxes `fileGeneration` checks |

## Rejected alternatives (and why)

| Alternative | Why not |
|---|---|
| Attach to an already-running pi from outside (CDP/`--inspect`, `gdb`, `strace`, re-writing its fds) | violates the public-API rule, is unsafe on the user's process, and breaks on every pi upgrade |
| Fake "live" from the JSONL tail | P-12: the bytes for in-flight tokens/thinking/tool output do not exist on disk; inventing state breaks the honesty invariant |
| Keep the server-dials-bridge design and just fix discovery | chosen for P0 because it is a bug fix, but it cannot fix stale-record cleanup, wrong-dir invisibility, "server started later", per-runtime artifact sprawl, or the circular pid attestation — so it is a dead end for the actual requirement |
| Extension POSTs to the HTTP API over loopback TCP | needs a port + HTTP credentials in the same places, adds a network listener and CSRF/Host surface for a purely local hop; UDS keeps the attack surface at one `0600` file |
| Browser answers terminal dialogs | P-9: no response handle in the public API; simulating a click by injecting a prompt would be a lie with side effects |
| Let pi-web spawn the user's terminal pi | cannot retroactively wrap a TUI the user already started; managed sessions already cover "start it from the browser" |
| Force-takeover of an unbridged file into an SDK host | no proof the other writer exited (plan R-01); stays the explicit, evidence-gated P6 path in `plan/terminal_live_control_plan.md` |
| One shared bridge process (daemon) that all pis talk to | adds a lifecycle, a port, and a new failure domain; the pis themselves are already the only place the live state exists |
| Put the bridge code inside `@piwebui/pi-web` and copy it in | that is today's B-1/K-2; an npm Pi package is the supported, discoverable, self-updating route |

## Open questions (need Hadi's call before P1)

1. **Package name**: `@piwebui/pi-web-bridge` (mirrors the server, recommended) vs `@piwebui/bridge`
   vs `pi-web-bridge` (unscoped, gallery-friendly). The npm *first publish of a new package under OIDC
   is a one-time manual step* (`K-4`) — so pick once.
2. **Auto-trust default**: auto-trust same-uid runtimes (zero-config, recommended) or first-connection
   approval in the browser (safer, adds one click per machine/pi)?
3. **`/new` behaviour**: new session row + old row retired to mirror (recommended, matches the disk) or
   re-key the visible row?
4. **Remote `pi` on another host**: is the `ssh -L` story enough for now? A reverse mode (extension
   dials `wss://host/api/v1/bridge` with a pairing code) is a real second project: auth, TLS pinning,
   reconnect and revocation semantics; I would keep it out of this workstream and document `ssh -L`.
5. **Windows support**: claim it (named pipes phase F-1) or state POSIX-only in `README`/`engines` until
   someone with a Windows box can run the matrix?
6. **Version pin**: keep fail-closed with an override (recommended) or move to "protocol-compatible =
   writable" once the protocol negotiation has survived one pi minor?

## Sequencing against the existing plan

`plan/terminal_live_control_plan.md` (D1–D6, P0–P6) reached the same diagnosis with a
registry-hardening remedy. This document supersedes its **transport** decisions (its D1 env/persisted
bridge.json analogue = our D-1/D-2; its D3 "keep the socket open" = our D-4) and keeps its identity
(D2 → our D-3), presence (D5), and honesty (D6) work items. Its P6 (promote a session whose terminal is
gone) stays out of scope here. `bidirectional.md` should be rewritten at the end of P4 so the repo tells
one story.
