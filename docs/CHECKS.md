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

## Automated — full-stack smoke (`npx tsx e2e/server-smoke.mts`)

Boot, auth (exchange/CSRF/host checks), workspace allowlist, meta/capabilities, managed session
create, SSE snapshot-on-subscribe, control grants, idempotent command dispatch, live phase
transitions over SSE, persistence-by-pi, static client serving, reconnect Last-Event-ID behavior,
**four concurrent independent managed sessions** prompted in parallel, replayed idempotency keys,
pure-read stats. See script for exact assertions S1–S20.

**Status note (dated 2026-11-05/06):** full run completes with **0 failures** (S1–S8b–S20; last recorded 13/22 pass, 9 skip, rc=0). The skipped rows are exclusively live-managed-host assertions starved by a machine-wide I/O storm that began ~16:45 on 2026-11-05 and persisted >12h: macOS `fileproviderd` sustained 90–220% CPU, `socketfilterfw` scanned every new node exec (`readFileSync` → ETIMEDOUT), cold process loads took 10–40 min at <1s CPU each. The same host-lifecycle behaviors (prompt ack, streaming previews, queue, dialogs, four-host capacity, handoff) pass under `p0:verify` section B, which completed on this machine before the storm. The orchestrator keeps re-running the smoke when windows open (`/tmp/orch2.sh` → `/tmp/smokeE.log`); SKIP rows become PASS whenever a host can load inside its 10-minute window.

## Automated — unit/type

- `tsc` clean on shared, pi-adapter, server, client (strict; exactOptionalPropertyTypes).
- okhsl conversion vendored from pi's MIT Oklab math; parity-checked against pi theme JSON.

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
