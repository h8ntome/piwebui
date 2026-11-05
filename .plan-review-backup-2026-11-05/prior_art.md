# Prior Art & Positioning

Reviewed 2026-11-05. Important finding: **`pi-web` already exists**, several times over,
one instance at significant scale. This file exists so we build deliberately rather than
by accident.

---

## Existing pi web UIs

| Project | Scale | Stack (observed) | Approach |
|---|---|---|---|
| **agegr/pi-web** | MIT, ~7.9 k stars, npm `@agegr/pi-web`, i18n (EN/zh/ja/ru), demo site | Next.js + React; deps include `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui`, `node-pty`, `@xterm/xterm`, `proper-lockfile`, `typebox`, `web-push`; port `30141`, `127.0.0.1` default | **In-process SDK**: `createAgentSessionServices`, `createAgentSessionFromServices`, `SessionManager.open/create` ✓ — same integration class as our D-02. Full product: session workspace grouped by project, running state/context/cost/compaction, two branch modes ("new session" vs "edit from here"), file browse **and upload**, git diff, worktree switching, provider login + API key management in-browser, plugin/skill config, i18n, web-push, `status/stop/open/update` CLI, Docker + proxy docs, a documented `pi-web:session-row-contextmenu` hook for Electron wrappers and a `session-liveness` registry so extensions can veto idle eviction |
| **pi-web.dev / "PI WEB"** | product site | server-side workspaces | Different centre of gravity: sessions keep running **server-side** after the browser leaves; supervise/redirect/review from any device. Overlaps our F-01/detach story but as a hosting product |
| **ravshansbox/pi-web** | GitHub | `npx pi-web@latest`, port `8192`, `--host` default `127.0.0.1` | Thin, honest: **no built-in authentication**, recommends Tailscale HTTPS. Closest to our minimalism, less scope than ours |
| **ygncode/pi-web** | GitHub page | PWA | Remote-control + PWA, multi-session dashboard, browse/read/continue from phone/tablet; overlaps our mobile story |

### What they validate

| Our decision | Independent confirmation |
|---|---|
| Loopback bind by default, Tailscale for remote (Q-03) | Both agegr (`127.0.0.1` default ✓) and ravshansbox (Tailscale HTTPS recommended, no auth ✓) land in the same place |
| `npx` single-command install (G-7) | Every one of them |
| SDK in-process as the default integration (D-02) | agegr uses exactly `createAgentSessionServices` + `SessionManager` ✓ |
| SSE + a "lease" concept | agegr exposes `/api/agent/[id]/lease` and `/events` routes and a session-liveness registry |
| A session created but never prompted has no file (our lazy-create note ✓) | agegr documents the same edge: "Sessions not yet saved to disk get no built-in menu" |
| Idle session eviction is necessary | agegr built exactly that, with extension veto power |
| Grouping sessions by project | Universal across all of them |
| Node ≥ 22.19 | Their stated floor equals pi's own engines field ✓ |

### What we avoid

| Their feature | Why we refuse it |
|---|---|
| **Embedded terminal** (`node-pty` + xterm) | Browser-driven pty is independent execution — the exact boundary D-01/D-11 draws. It also makes the web server a remote shell, which changes the whole security posture ([security.md](security.md#threat-model)) |
| **Provider login / API-key management in-browser** | Secrets entered into a web form on a localhost server that any local process can also read: added risk, no added convenience when the terminal is one keystroke away. We display provider/auth *state*, never edit it |
| **File upload** | A write path into the filesystem from the browser is a permanent security surface (agegr limits it to known roots ✓; we simply don't have one — [security.md](security.md#read-only-file-viewer-and-path-containment) rule 6) |
| **Git worktree create/remove** | Execution again (N-11). Read-only status/diff is enough for a viewer |
| **Settings/config editing UI** (models, plugins, skills, MCP) | pi owns configuration; `pi config` and `pi /login` already do it. Duplicating it means two UIs to keep in sync with pi's internals — the single biggest long-term maintenance tax in the feature-complete approach |
| Web-push, i18n, Electron hooks, demo site | Legitimate for a product with users; premature for v1 of a personal tool (backlog) |
| "Mark read/unread", "archive" | Invented state that lives only in the web app and will drift from pi's view (D-10) |
| Feature parity as a goal | Parity pressure is risk R-10 with a mascot |

### Relationship to agegr/pi-web specifically

The name and the scope overlap is not a coincidence — the constraints of the problem funnel
you here. Three defensible positions:

1. **Personal tool, no market collision** (this plan's default): we are not competing for
   users; the folder and package can carry whatever name Hadi likes (Q-01).
2. **Contribute**: our distinct pieces — the divergence detector, the quiet-window
   take-control rule, the driver equivalence test, the strict "no terminal / no editor /
   no config UI" contract — are small and could land as a mode in their project.
3. **Fork-free differentiation**: keep the surface this plan describes and be explicit in
   the README about the difference: *pi-web (ours) renders and relays; it does not run a
   terminal, edit files, store credentials, or manage pi's configuration.*

Option 3 is the plan; option 2 stays open and costs nothing until we ship.

## Reference interfaces

### DeepSeek web

Single centre column, minimal chrome, thread list as plain rows, centred composer when
empty, model selector demoted to a control. Adopted wholesale in the layout
([ui_design.md](ui_design.md#reference-analysis)). Rejected: chat bubbles, which
misrepresent what a pi session is.

### Codex desktop (macOS app)

Multi-agent parallel threads grouped by project; per-thread review of the agent's changes;
composer bottom row carrying permission · model · reasoning; bottom status bar
(`Local · permissions · branch · changed lines`); and a prominent **Hand off** action.
Adopted: project grouping, the rich composer bottom row, the status bar, and hand-off as a
first-class button (ours: *Continue in terminal*). Rejected: the permission control (pi has
no such knob to expose), and public commentary about added window chrome is a useful
reminder not to build fake chrome.

### Claude Code desktop

Drag-and-drop pane grid (chat/terminal/diff/preview), side chat (`⌘+;`), parallel sessions
with git worktree isolation, integrated editor and terminal. Adopted: almost nothing, and
that is the point — it is the cautionary reference. Each of those capabilities requires the
UI to become an execution environment. Our answer to "the transcript isn't enough" is to
make the transcript actually enough (P-1), plus a read-only panel.

### Also informative, not imitated

pi's own **HTML export** (`/export`, `/share` ✓) — it is pi's own opinion about how a
session should look outside the terminal, including `pageBg`/`cardBg`/`infoBg` export
colours ✓. Our palette work starts there rather than inventing a web look
([visual_design.md](visual_design.md#source-of-truth)). pi's **TUI** is the real visual
spec: bordered tool rows, `blueBg` user bands, dim metadata, the footer status line — those
are the things a visitor recognizes as "pi".

## Positioning statement

> Where existing pi web UIs are **pi workstations in a browser** — terminal pane, file
> upload, credential management, config editing — this pi-web is a **thin window onto pi**:
> the same session files, the same agent, full control of what pi does, and nothing else.
> One job done so thoroughly that it can be read in one scroll: see exactly what pi is doing
> and steer it, from anywhere, without ever doubting that what you see is what pi recorded.

Measurable consequences of that stance, all already in the plan:

| Metric | Ours | Why |
|---|---|---|
| Production dependencies | ≤ ~45 total ([security.md](security.md#dependency-budget)) | no pty, no editor, no config UI, no push |
| Endpoints that can mutate the filesystem besides pi's own tools | **0** | upload/write/config all absent |
| Ways the UI can silently diverge from the session file | **0 by construction** (D-05, R-03) | reads come from pi's own functions; writes go through pi |
| Lines of pi-internal `dist` access | **0** | we read theme JSON and use public exports ✓, so upgrades hurt less |
| Time to first useful screen | < 5 s cold, no auth flow | G-7 |

## Maintenance obligations

- Re-check this file each release: the ecosystem moves fast and a project can go from 0 to
  thousands of stars between pi versions ✓.
- Keep a written record of which prior details we copied (this file is that record) so the
  next contributor does not "invent" them again and we do not drift into parity-chasing.
