# Verification ledger

Every claim about pi-web must point at a dated check here or in `CAPABILITY_MATRIX.md`.
Status vocabulary: **PASS** (automated, re-runnable), **BLOCKED** (upstream capability missing,
documented), **NOT RUN** (manual/heavy; described so a human can run it).

Last full automated pass: 2026-11-05 (this session).

## Automated — capability matrix (`npm run p0:verify` → docs/CAPABILITY_MATRIX.md)

| Area | Rows | Result |
|---|---|---|
| Pure read paths (parity, no-mutation, legacy, framing, bounds) | 10 | PASS |
| Managed SDK host lifecycle (ack, previews, mapping, queue, dialogs, handoff) | 21 | PASS |
| Live terminal bridge under a real PTY (prompt/steer/abort/model/thinking/rename/reload/new) | 26 | PASS |
| Terminal extension-dialog **remote response** | S-13b | BLOCKED (public pi 1.5.0 API has no response handle for another extension's terminal dialog; observation works) |

## Automated — terminal bridge smoke (`npm run smoke:bridge`)

The bridge definition-of-done, against a **real** `pi` in its own pty and a **real** `pi-web`
server started the way a user starts it, with the bridge installed the way a user installs it
(`pi install <package>`) and **no bridge environment variables** in the `pi` process. 27 rows:
descriptor modes and the token never being printed, zero-config adoption (incl. before the session
file exists), live preview/toolState/runtimeState/entry counts for a terminal turn, browser
prompt(start)/prompt(steer)/rename/setThinking reaching that same PID, `/new` retiring the old row
and adopting a new live one, the machine-wide stream, `pi-web doctor`, terminal input still working,
and a `kill -9` fallback to mirror. Last full pass: **27/27** (2026-11-08).

Unit coverage of the same machinery (no browser, no TUI): `packages/pi-extension/test/*.test.mts`
— descriptor resolution order and malformed/stale input, frame codec + replay ring + limits
parity with the server, hub lifecycle (instance replacement, stale handles, double-load guard,
mode gate), command mapping (busy policy, operation dedup, 501s), and `test/integration.test.mts`
which drives the extension against the real acceptance gates over a real unix socket (attestation,
duplicate runtime, wrong token, no-hello timeout, revoke, replay-after-reconnect, late server).

## Automated — full-stack smoke (`npx tsx e2e/server-smoke.mts`)

Boot, auth (exchange/CSRF/host checks), workspace allowlist, meta/capabilities, managed session
create, SSE snapshot-on-subscribe, control grants, idempotent command dispatch, live phase
transitions over SSE, persistence-by-pi, static client serving, reconnect Last-Event-ID behavior,
**four concurrent independent managed sessions** prompted in parallel, replayed idempotency keys,
pure-read stats, the **workspace folder picker** (`S21`–`S30`: level listing shape, host paths and
hidden flags, root-to-target crumbs, home default, `invalid_request` on a relative path,
`directory_unreadable` instead of a raw node error, `New folder` create, `directory_exists`, single-segment
name refusal, CSRF on the create). See script for exact assertions S1–S27.

**Recorded 2026-11-09 (`npm run smoke`): 33/33 passed, 0 skipped**, on devbox (Linux, node 24, pi 1.5.0),
after the folder-picker rebuild.

**Status note (dated 2026-11-05/06):** full run completes with **0 failures** (S1–S8b–S20; last recorded 13/22 pass, 9 skip, rc=0). The skipped rows are exclusively live-managed-host assertions starved by a machine-wide I/O storm that began ~16:45 on 2026-11-05 and persisted >12h: macOS `fileproviderd` sustained 90–220% CPU, `socketfilterfw` scanned every new node exec (`readFileSync` → ETIMEDOUT), cold process loads took 10–40 min at <1s CPU each. The same host-lifecycle behaviors (prompt ack, streaming previews, queue, dialogs, four-host capacity, handoff) pass under `p0:verify` section B, which completed on this machine before the storm. The orchestrator keeps re-running the smoke when windows open (`/tmp/orch2.sh` → `/tmp/smokeE.log`); SKIP rows become PASS whenever a host can load inside its 10-minute window.

## Automated — unit/type

- `tsc` clean on shared, pi-adapter, server, client (strict; exactOptionalPropertyTypes).
- okhsl conversion vendored from pi's MIT Oklab math; parity-checked against pi theme JSON.
- **Folder picker rules (`packages/server/test/directories.test.mts`,
  `packages/client/test/directories.test.mts`, both under `npm run test:unit`).** The server suite pins
  the per-platform path rules from any host — `fullyQualified` on linux/darwin/win32 (including the Windows
  forms the reference refuses: `C:x`, `/foo`, `\\server`), `parentOf` up to `/` and up to "This PC",
  `ancestryCrumbs` labelling, the bounded insertion window, and real listings (directories only, sorted,
  hidden flagged, symlinks offered under their own name rather than `realpath`'d, `directory_unreadable`
  instead of a raw node code, single-segment create refusal, `directory_exists`, the macOS privacy copy).
  The client suite pins what the panes show: separator inference from the host's home path, draft→directory
  reading on both separator styles, breadcrumb folding at Home, and the hidden/prefix filter rules.
- **Native chooser + routing (`packages/server/test/native-picker.test.mts`, 22 tests, and
  `packages/client/test/device.test.mts`, 5 tests).** The resolver suite pins who is allowed a window:
  Mac-on-Mac and Windows-on-Windows get Finder / Explorer; a Mac browser on a Linux host, a non-loopback
  peer, an SSH-launched server, an unidentifiable browser, a headless Linux box and
  `PIWEB_NATIVE_PICKER=off` all get the in-app browser, each with the reason that says so; `force`
  re-opens the tunnel case. The chooser suite runs each platform branch against a stand-in runner and
  pins the important distinctions — the prompt and starting folder reach the child as argv/env (never
  interpolated into the script), Finder's cancel is exit 0 with an empty line while a non-zero exit is a
  failure with its stderr, zenity's exit 1 is a cancel, a missing zenity falls through to kdialog but a
  *broken* zenity is reported, one panel is shared by concurrent callers, a caller that hangs up closes
  the panel, and the watchdog kills a chooser that never answers.
- Cross-OS check that does not need a Windows or macOS machine: the pure rules above are platform-parameterised,
  and `npx tsx e2e/lib/picker-platform-stub.mts <port> <win32|darwin> <upstream>` serves the real client a
  simulated host so the dialog can be driven through a Windows tree (drives, `D:\`, "This PC") or a macOS
  tree with TCC-denied folders. See `docs/research/directory-picker.md`.

## Automated — release and registry gates

The failure these exist for: a green build, a green publish, and a user who still cannot type the
command. Full story in [`../npm_fix/README.md`](../npm_fix/README.md).

| Check | What it proves | Last pass |
|---|---|---|
| `npm run check:cli` | tree side: `bin` = declared names, launcher present + shebang'd + inside `files`, every command-like token and every `pi-web <subcommand>` in the docs shipped and dispatched (docs = README, MAINTAINERS, CHANGELOG, `docs/**` minus `docs/research/`, `packages/<pkg>/README.md`) | 2026-11-08 |
| `npx tsx --test scripts/test/cli-names.test.mts` | the parsers above actually match (a silent parser is a gate that passes on the bug) — 6 tests, fixtures in temp trees | 2026-11-08 |
| `npm run package:smoke` | artifact side: pack → clean install → `packed bins: pi-web, piweb` → boot → `--version`/`--help`/bad-flag exit 2/`--port 0` → real `npm i -g` into a scratch prefix → installed server answers `/api/v1/health` | 2026-11-08 (`0.1.1`) |
| `npm run verify:published -- --tag latest --all` | registry side: the four packages are **one release** (same version, published within one 6h window), `bin` declares the documented names, the tarball carries the launcher + `dist/main.js` + `client-dist/index.html`, `npm i -g` lands a working `pi-web`/`piweb --version`, and the published `dist/main.js` dispatches every documented subcommand | 2026-11-08 (`next` green; `latest` red by design until `v0.1.1`) |
| `registry drift` workflow | the registry side, re-run daily with no publish in front of it | first run 2026-11-08: **FAIL**, naming the 18h `latest` skew — the alarm working |

Negative tests of the gates themselves (scratch trees, same day): dropping `pi-web` from `bin` → 3
failures; documenting a subcommand the dispatcher dropped → 1 failure; `pi_web` typo in a fenced
block → failure; undeclared `bin` name → failure. Each exits 1.

## Automated — browser UI pass (agent-browser, headless Chromium)

Dated 2026-11-06 against the warm server on loopback:

- Login screen renders; bootstrap-code exchange → cookie+CSRF → authenticated shell ✔ *(historical: the
  login page was removed later the same day — see the 2026-11-07 pass below)*
- Code is single-use (second exchange rejected) — enforced server-side, UI reflects it ✔
- Zero console/page errors on login, reload, theme toggle (`agent-browser errors` empty) ✔
- Pi-derived dark palette actually applied from `/api/v1/themes/current` (`body background rgb(10,10,10)` = pi `dark.json` pageBg) ✔
- Honest disabled composer state for uncontrolled sessions ("no controllable runtime (file mirror / history)") ✔
- Screenshot: `/tmp/piweb-ui-login-shell.png`

This pass caught two real client bugs, since fixed: `refreshSessions` waited on the (slow) session
list before fetching workspaces (＋new button never appeared), and it mapped `w.key` where the API
returns `workspaceKey`.

**Dated 2026-11-07 — login page removed.** The login card, the one-use bootstrap code and the
`sign out` affordance are gone from the client, and the server issues an anonymous session cookie on
the first `/api` request. Re-verified against a throwaway data dir on loopback:
- Cookie-less `GET /api/v1/sessions` → 200 + `set-cookie: piweb_session=…` (no 401 anywhere) ✔
- Browser opens straight onto the session list; clicking a row renders its transcript, `agent-browser
  errors` empty ✔
- Mutations without `x-piweb-csrf` → 403; with a foreign `Origin` → 403; with a valid token the request
  reaches the handler ✔
- Removed routes (`/auth/exchange`, `/auth/login`, `/auth/logout`) are no longer registered, and
  `pi-web help` no longer advertises `mint-code` / `logout-all` ✔
- `npm run smoke`: **21/23 passed** end to end with no login anywhere in the flow (`S1`–`S4b` assert the
  new contract; `S17` and `S20` are pre-existing failures unrelated to auth, recorded in `CHANGELOG.md`).

## NOT RUN — manual, intentionally honest

| Check | How to run | Why not run yet |
|---|---|---|
| NetBird physical-phone session (iOS Safari + Android Chrome) | Follow README “Phone access over NetBird”, open the UI from the phone (no login), prompt, lock phone mid-run, unlock, reconnect SSE | Requires physical devices on the NetBird mesh |
| Screen-reader pass (VoiceOver) | Walk the rail/composer/dialog modal with VoiceOver; composer and dialog have roles/labels in code | No automated accessibility harness in this environment |
| 24-hour soak (leaks, epoch rollover, ring bounds) | `npm run p0:verify && for i in {1..24}; do npx tsx e2e/server-smoke.mts; sleep 3600; done` | Multi-hour wall clock |
| TLS termination behind proxy on NetBird interface | Configure local Caddy/nginx per README; verify Secure cookie + Host/Origin enforcement | No pi-web-owned certificate/endpoint provisioned in this session; existing Paseo proxy left untouched as instructed |
| Browser end-to-end UI interaction suite | vite + Playwright against mock provider | App shell, palette, error-free boot verified manually via agent-browser (above); scripted flow incl. prompt-through-UI screenshot queued as follow-up |

## Environment observations (dated 2026-11-05)

- Node v26.12.1, npm 11.20.0, pi 1.5.0 (global and repo-pinned identical).
- Machine under macOS fileproviderd/ANE load spikes during development; import latency from
  ~3s to >60s observed — affects wall-clock of tests, not correctness.
- NetBird interface present (`100.108.239.49`); existing Paseo proxy on :6767 untouched.
- No public ingress created or modified by pi-web at any point.

**Dated 2026-11-09 — the native folder chooser.** End to end against throwaway data dirs on loopback,
with `/tmp/fakebin/zenity` standing in for a desktop chooser (2 s "human" delay, and a mode that exits 1):

- `GET /api/v1/browse/mode?client=linux` on a `DISPLAY`+`zenity` host → `{mode:"native",chooser:"Zenity"}` ✔;
  `client=darwin` on the same Linux host → `browse` with the "browser is on macOS but pi-web is on Linux"
  reason ✔; no `DISPLAY`/`zenity` → `browse` naming the missing piece ✔
- `POST /api/v1/browse/pick` waits for the chooser (2.0 s) and returns `{path:"/tmp/native-picked/deep"}` ✔;
  a chooser that exits 1 returns `{path:null}` ✔; a client claiming another platform gets 409
  `picker_unavailable` and no window ✔; without `x-piweb-csrf` → 403 ✔
- **A panel does not outlive the tab that asked for it**: hang up at 0.5 s and no chooser process is left
  0.5–3.0 s later (`pgrep` sampled each 0.5 s); the next pick then works normally ✔
- Two tabs asking at once open **one** chooser (logged once) and both receive the same answer ✔
- `startingPath` reaches the chooser as its working directory, and only after the host has checked it is a
  real directory (a bogus path is ignored rather than refused) ✔
- Browser pass (`agent-browser`): on the chooser host, `Add workspace` → "Zenity is asking you to choose a
  folder" with `Browse folders` / `Cancel` / `Choose again`, and the workspace appears by
  itself when the chooser answers ✔; on a host with no chooser, `Add workspace` → the Miller dialog and
  `Open` adds the workspace (toast `Workspace dev added · /home/dev`) ✔
- `npm run smoke`: **38/38** (new rows `S28`–`S30`); `npm run test:unit`: 143 tests (22 of them the new chooser/routing suite, 5 the device claim); `tsc` clean on all
  four projects; `npm run check:cli` green after the README/SECURITY/CHANGELOG updates.

**Dated 2026-11-09 — install freshness (`pi-web update`, version badge).** The failure being closed was
operational, not code: the global install on this box was `@piwebui/pi-web@0.1.0` (4 days old) while
`@latest`/`@next` had moved, and nothing on screen said which build a tab was talking to.

- `npm i -g @piwebui/pi-web@next` → `pi-web --version` = `0.1.2-canary.20.1e822e9`, and that installed
  tree contains the picker work (`dist/nativePicker.js` present, `routes.js` registers `browse/mode`
  and `browse/pick`, the client bundle carries the chooser copy) ✔
- `pi-web update --check` (no install) and `pi-web update` (idempotent on the newest build) ✔;
  `--json` shape asserted by unit tests; a checkout is refused rather than overwritten ✔
- Prefix derivation is path-based, not `npm prefix -g`: this box has two Node installs
  (`~/.local/lib/node_modules/node` and `~/.npm-global`), and the updater must touch the one running ✔
- `systemctl --user enable --now pi-web.service pi-web-update.timer`: service active, health answers
  `{"version":"0.1.2-canary.20.1e822e9"}`, timer armed (`list-timers`), linger `yes` so both survive
  logout ✔
- `pi-web update` unit tests: canary ordering (`canary.2 < canary.10`, release > its own canaries),
  tag defaulting, plan text for registry-unreachable, check-never-installs, install-targets-own-prefix ✔

**Dated 2026-11-09 — the update loop, run for real (not simulated). An install older than
`0.1.2-canary.22` has no `update` command at all, so the bootstrap is one manual `npm i -g`; the loop
below starts from a build that has it.** The stale-install state above
was repaired and then the fix was exercised end to end:

- `npm i -g @piwebui/pi-web@0.1.2-canary.22.e3e41f1` into the prefix on PATH; `pi-web --version` and
  `/api/v1/health` both report it, and the installed tree contains the picker work
  (`dist/nativePicker.js`, `browse/mode` + `browse/pick` in `dist/routes.js`, the chooser copy in the
  client bundle) ✔
- **Downgraded the installed manifest back to `0.1.2-canary.19` to make a stale install on purpose.**
  `pi-web update --check` named both versions and installed nothing; `pi-web update --restart` then
  installed `0.1.2-canary.22`, restarted `pi-web.service`, and the running server answered the new
  version ✔ (this is exactly what the daily timer runs)
- `systemctl --user enable --now pi-web.service pi-web-update.timer`: service `active`, timer armed
  for 04:40 (+randomised), `Linger=yes`, and `pi-web-update.service` ran with `Result=success` ✔
- Sidebar chip renders `pi-web 0.1.2+22.e3e41f1` beside `pi 1.5.0` (agent-browser snapshot +
  screenshot of the live service) ✔
- `pi-web update` refuses a source checkout (no `dist/main.js`) instead of npm-installing over it ✔

- The vestigial top-level globals `@piwebui/shared@0.1.0` / `@piwebui/pi-adapter@0.1.0` (left by an old
  workspace install, and the reason `npm ls -g` still read `0.1.0` after the update) were checked for
  importers, removed, and the service re-verified: `npm ls -g` now shows one line, health answers
  `0.1.2-canary.24.f964dbf` from the copies nested inside `@piwebui/pi-web` ✔
- `pi-web update` (real registry, not a stub): at `0.1.2-canary.22` the installed build reported
  `0.1.2-canary.24` on `@next`, installed it into its own prefix and restarted the service; health then
  served `0.1.2-canary.24` ✔

