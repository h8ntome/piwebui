# Pi ↔ pi-web automatic bridge — audit and technical plan

Status: **plan for approval** (no implementation) · Date: 2026-11-08 · Author: pi (read-only audit)
Audited tip: `512e9a3` · pi `1.5.0` (`/home/dev/.local/lib/node_modules/@earendil-works/pi-coding-agent`)
This audit wrote **only** files under `bridge_plan/`; no source file was touched. Note that the working
tree was dirty and being edited by another concurrent pi session during the audit — see the tree-state
note at the top of `01-audit.md`.

## Goal

A user runs two commands, once:

```bash
npm i -g @piwebui/pi-web                 # the web UI + server
pi install npm:@piwebui/pi-web-bridge    # the new Pi extension (one line, one time)
```

…then, forever after:

* `pi-web` starts → open the printed URL → **every terminal `pi` they have open shows up as
  `Terminal (bridged)` (live), not `read-only`**, within ~2 s (or ≤ 15 s if `pi` was already running
  before `pi-web` started).
* Thinking, tool calls, tool output and the answer itself **stream token-by-token** into the browser.
* The browser can **send prompts** (start / steer / follow-up), abort, rename, switch model and
  thinking level to that same `pi` process — while the terminal keeps working normally.
* `/new`, `/resume`, `/fork`, `/reload` inside `pi` keep all of the above working with no user action.
* **No environment variables, no `pi -e <path>`, no token copy-paste, no `piweb allow`** for bridged
  sessions, no restart of an already-running `pi` after installing the extension (it connects on the
  next retry tick).

## The eight decisions this plan rests on

| # | Decision | Replaces | Why |
|---|---|---|---|
| **D-1** | **The extension dials the server.** pi-web listens on one Unix socket per server (`<dataDir>/bridge-<serverId>.sock`); each `pi` connects out to it. | today: each `pi` listens on its own socket + writes a registry record, and the server polls a directory | removes the entire class of stale-record / wrong-dir / wrong-token failures (RC1–RC3), makes "server started after pi" work, one artifact instead of N, attach latency = a TCP-less `connect()`, no cleanup of other people's sockets |
| **D-2** | **The server publishes a bridge descriptor** `<dataDir>/bridge.json` (`0600`) carrying `{serverId, socket, token, protocol, http, pid, procStart}`; the extension resolves it from a documented search path | `PIWEB_BRIDGE_TOKEN` / `PIWEB_BRIDGE_DIR` env vars in every `pi` process | this is what makes it zero-config; a file the same uid wrote is the only secret handoff that survives "user starts pi in a shell that never saw pi-web" |
| **D-3** | **Runtime identity = pi `sessionId` (UUID)**, session-file path is secondary and may not exist yet | path-first identity with `b_<runtimeId>` placeholders | live-verified: `session_start` reports `sessionId` and a pre-allocated `sessionFile` while the file **does not exist** (`fileExists:false`), so path-first identity structurally cannot represent a fresh session (E6/E12) |
| **D-4** | **One bridge endpoint per pi process, session-replacement-safe**: a `globalThis` singleton owns the socket; every extension instance re-binds its own `pi`/`ctx` into it | close the socket on `session_shutdown{new,resume,fork,reload}` | live-verified: `/new` re-runs the extension factory in the **same pid** with the same `globalThis`; the socket created by instance 1 keeps serving, and prompts work through instance 2's refreshed `pi` handle (§A.4) |
| **D-5** | **Ship as a real Pi package** `@piwebui/pi-web-bridge` (`pi` manifest, zero runtime deps, Node builtins only), installed with `pi install npm:…` | `pi-web install-bridge` copying `pi-web-bridge.mjs` into `~/.pi/agent/extensions/` (which pi never auto-discovers: only `.ts`/`.js`) | `pi install` is the supported, self-updating, discoverable path (verified locally: it writes `settings.json.packages`, and the package's extension loads on the next `pi` start) |
| **D-6** | **Token + descriptor permissions + process attestation** (claimed `pid` must be a live process whose cmdline looks like pi and whose start time matches `procStart`) + an explicit runtime trust list with revocation | comparing a record and a hello that the *same* bridge wrote (self-consistent, not attested) | the dial model gives an inbound listener, so identity must be verified against something the bridge does not control |
| **D-7** | **Keep the proven streaming vocabulary** (message/tool/agent/turn/dialog events, 40 ms & 80 ms coalescing, `turn_end.messageEntryId` → entry mapping) and add only: per-runtime `seq`, a bounded replay window, and an explicit backpressure policy | a new event model | E8/E9 already proved this vocabulary carries live thinking + tools + tool output and accepts prompts end-to-end; rewriting it is risk without value |
| **D-8** | **Say why, always**: `/api/v1/runtimes`, one server-wide SSE (`/api/v1/events`), `pi-web doctor`, a TUI status line + `/piweb` command, and a "Connect this terminal" CTA in the composer instead of a dead input | silent `console.error` inside a TUI, silent `423 read_only`, silent version pin | RC3/RC5/E15: the mechanism works and adoption is what fails; invisible failure is indistinguishable from broken |

Rejected alternatives are in the like-named section of `04-rollout-and-validation.md` (CDP/debugger
attach, JSONL-tail "fake live", letting pi-web own the user's terminal, force-takeover of an
unbridged file, browser answering of terminal dialogs, HTTP/WebSocket instead of a UDS).

## Documents

| File | Contents |
|---|---|
| `01-audit.md` | What pi, pi-web and the current bridge actually do; 13 bridge defects + 4 packaging findings, each with `file:line` or measurement evidence; what is already good |
| `02-extension-design.md` | `@piwebui/pi-web-bridge`: package layout, lifecycle, discovery, wire protocol, streaming, command handling, generations, failure behaviour, limits |
| `03-server-changes.md` | pi-web backend changes, file by file: bridge listener, descriptor, identity/adoption, API additions, DB migration, client follow-ups, security |
| `04-rollout-and-validation.md` | Phases P0–P5 with exit criteria, 22-case verification matrix, risks, effort, rejected alternatives, open questions |
| this file | Goals, decisions, reading guide |

## Headline audit findings (details in `01-audit.md`)

1. **The bidirectional mechanism already works.** With a correctly configured bridge, one terminal
   turn produced `preview=19 toolState=3 runtimeState=4 entry=3`, and `prompt(start|steer|followUp)`,
   `rename`, `abort` all returned `202 accepted` and executed in the terminal process. The "mirror
   only" symptom is an **adoption** failure, not a capability failure.
2. **A file mirror can never stream.** Pi appends a record only when it is complete: during a 6 s
   streamed reply the JSONL did not change at all. An in-process owner is mandatory.
3. **`install-bridge` today installs a file pi never loads** (`pi-web-bridge.mjs`; auto-discovery
   accepts only `*.ts`/`*.js`) and nothing persists the token/dir, so a normally started `pi` can
   never be adopted.
4. **The published `latest` (`@piwebui/pi-web@0.1.0`) has no `pi-web` bin** — only `piweb`. That is
   the whole of `npm_fix/npm_install_error.md` (`zsh: command not found: pi-web`); the alias exists in
   the repo but has never been published to `latest`.
5. **`SO_PEERCRED` is not available from Node's public API** (`getSocketCredentials`/`getPeerCredentials`
   do not exist in Node 24.22.2 — measured), so the trust model must be token + file modes +
   process attestation, and must be documented as "same-uid is the trust boundary".
6. **pi re-instantiates extensions on session replacement** (`session_shutdown{reason:"new"}` →
   factory again → `session_start{reason:"new"}`, same pid, same `globalThis`), and a `pi` handle
   captured by the previous instance throws afterwards (measured) — hence D-4's refreshed-handle
   pattern.
7. Node/npm facts that make the zero-config story real: `pi install npm:…` → `~/.pi/agent/npm` +
   `settings.json.packages`, auto-loaded on every start; `-e` accepts npm sources; the CLI launcher
   already resolves its own install layout.

## Definition of done

See §"Definition of done" in `04-rollout-and-validation.md`. Short form: *install once, every terminal
pi is live in the browser within 2 s of its first session start, streams everything, accepts browser
prompts, survives session switches, and tells the user (in the terminal and in the browser) exactly why
it is not connected when it cannot be.*
