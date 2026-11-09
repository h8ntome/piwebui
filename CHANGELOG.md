# Changelog

All notable changes to pi-web are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims for
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts here: pi-web was developed in a single working branch, and **`0.1.0` was published to
npm by hand on 2026-11-07** (see `MAINTAINERS.md` for why that artifact is incomplete). No historical
releases are back-filled below — each release cut replaces the `Unreleased` section with a dated entry.

## [Unreleased]

### Added

- **`@piwebui/pi-web-bridge`: a terminal `pi` is live in the browser with zero configuration.**
  Install it once (`pi install npm:@piwebui/pi-web-bridge`) and every `pi` you start afterwards —
  in any project, with no environment variables, no `pi -e`, no `piweb allow` and no restart of an
  already-running `pi` — appears as `Terminal (bridged)` within ~2 s, streams thinking/tool calls/
  tool output/token-by-token answers, and accepts browser prompts, steering, abort, rename, model and
  thinking changes. `/new`, `/resume`, `/fork` and `/reload` keep all of it working. The design (and
  the audit that produced it) is in `bridge_plan/`; the user-facing notes are in
  `packages/pi-extension/README.md`.
  - **The direction reversed: the terminal dials the server.** Each `pi-web` publishes a `0600`
    descriptor (`<dataDir>/bridge.json`) and listens on one Unix socket per server
    (`bridge-<serverId>.sock`); bridges find it through a documented search order
    (`PIWEB_BRIDGE_DISABLE` → `PIWEB_BRIDGE_FILE` → inline socket+token → `PIWEB_DATA_DIR` →
    sibling-of-`PI_CODING_AGENT_DIR` → `~/.pi-web/bridge.json` → `~/.pi-web/servers/*.json` pointers).
    The stale-record / wrong-dir / wrong-token class of failures is gone because the bridge now
    writes nothing to disk at all.
  - **Identity is pi's `sessionId`**, not a file path, so a session that has no file yet (pi
    pre-allocates the path) is adoptable and shows as `live` instead of a `read-only` mirror twin.
  - **Acceptance is attested.** Token + `0600` file modes + process attestation (the claimed `pid`
    must be a live Pi CLI started within ±5 s of the claimed time) + a revocable runtime table.
    `pi-web trust-runtime` / `revoke-runtime`, `PIWEB_BRIDGE_DISABLE`, `--bridge-mode`,
    `--no-attest` and `bridge.allowCwd` are the knobs; `SECURITY.md` states the same-uid boundary.
  - **Presence and diagnosis.** `GET /api/v1/events` (server-wide SSE: `runtimeAttached`,
    `sessionAppeared`, `runtimeGone`, `sessionRetired`), `GET /api/v1/runtimes`,
    `GET /api/v1/bridge/diagnose`, `pi-web doctor [--json]`, a `● pi-web` footer status in `pi` and
    a `/piweb` command. The client subscribes to the global stream, so a tab learns about a new
    terminal session by itself.
  - **Ordering, replay, backpressure.** Per-runtime monotonic `seq`, a bounded replay ring
    (2000 frames / 4 MiB) that resumes a reconnect without a full resnapshot, and an explicit drop
    policy (previews first, tool output next, never `turn_end`/`agent_*`/`session_*`) with counters
    visible in `/api/v1/runtimes` and `/piweb`.
  - `pi-web install-extension` (copy-only installer, deletes the legacy `pi-web-bridge.mjs`),
    `pi-web rotate-bridge-token`, `pi-web pair`, `pi-web deprecate-bridge`.
- **Every package now updates on npm automatically, the bridge included.** `scripts/publish-list.mts`
  is the single derived source of the publishable set (every non-private workspace, in dependency
  order) and `release.yml` feeds it to the version gate, the tag check, the registry preflight, the
  canary stamp and the publish loop — the bridge was being left out precisely because that list was
  written out by hand in six places. `verify-published.mts --all` closes the far end of the loop:
  each publishable package must exist at the released version, must have its dist-tag pointing at
  it, and must ship the entry points its manifest advertises (the bridge's `pi.extensions` file).
  `scripts/test/publish-list.test.mts` fails the build if the list, the manifests and the workflow
  ever disagree, and `npm run publish:list` prints what CI will publish. A package npm refuses
  because its trusted publisher is not registered yet (the state of any freshly created package) is
  now skipped with a warning instead of aborting the loop, so it can no longer freeze the registry
  updates of every other package — the run still ends red, naming the package and the fix.

### Changed

- **The workspace folder selector is the reference's in-app browser, and it behaves the same on Linux,
  macOS and Windows.** `GET /api/v1/browse` used to answer `{ path, parent, home, entries[] }` with the
  level's own path (`realpath`'d) while the *browser* did the path arithmetic: child rows were joined as
  `level + "/" + name` and breadcrumbs were rebuilt by splitting on `"/"`. That is Linux/macOS arithmetic,
  not Windows arithmetic (`C:\Users\you`, drive roots, UNC shares), and it made the dialog disagree with
  itself about where it was. The host now answers the reference's shape — `crumbs` root-to-target,
  `{ name, path, hidden }` rows with fully qualified host paths, a directories-only bounded window, and
  `directory_unreadable` / `directory_exists` / `directory_create_failed` codes — and the browser only ever
  echoes a path back. `POST /api/v1/browse { path, name }` is new: the dialog's "New folder" button, one
  `mkdir`, one path segment, behind the same CSRF/Origin fences as every other mutation. The contained
  workspace file viewer stays in `packages/server/src/files.ts`; the picker moved to
  `packages/server/src/directories.ts`. The dialog itself is the reference's Miller view (680×500; one
  column until you pick a row, then two around a hairline divider; a click-to-edit path seeded with a
  trailing separator that prefix-filters the last pane as you type; a `Loading…` pill that only appears
  after 300 ms of silence; `New folder` → `Show hidden files` → `Cancel` / `Open`), served by the `browse`
  interaction rather than a native OS chooser because pi-web's server is often not the machine you are
  looking at. The reference contract, the per-platform matrix and how to re-verify are in
  `docs/research/directory-picker.md`.

- **Install commands name their dist-tag.** `npm install -g @piwebui/pi-web@latest` and
  `pi install npm:@piwebui/pi-web-bridge@latest` in the README and the bridge's own docs. npm already
  defaults to `latest`, so nothing resolves differently; what changes is that a pasted command states
  which release it asked for — the first question when an install is green but behaves like an older
  build (see `npm_fix/README.md`, cause D: npm can resolve `latest` from a packument it cached up to
  five minutes ago). Verified with `pi install`, `pi remove` and `pi -e` against the live registry.
- **`install-bridge` is deprecated in favour of `install-extension` / `pi install`.** The old
  installer wrote `pi-web-bridge.mjs`, a file pi never auto-discovers (only `.ts`/`.js`), which is
  the whole reason the bridge appeared not to work. `install-bridge` now installs the `.js` and
  removes the `.mjs`, with a note pointing at `pi install`.
- **The server banner no longer prints the bridge token** (it landed in shell history, CI logs and
  screen shares). It prints the one-line install command and the runtime count instead.
- **The pi version gate is loud instead of silent.** Writes stay fail-closed on an unvalidated pi,
  but `status.compat.detail`, `GET /api/v1/capabilities`, the sidebar and `pi-web doctor` now name
  the escape hatch `PIWEB_ALLOW_PI_VERSIONS=<version>`.
- Legacy registry transport (`PIWEB_BRIDGE_DIR` + `PIWEB_BRIDGE_TOKEN`) is still supported for one
  release behind `--bridge-mode both`; the dial connection wins when both exist, so one `pi` is
  never two drivers.
- `e2e/bridge-smoke.mts` (`npm run smoke:bridge`) runs the definition-of-done end to end: a real
  `pi` in its own pty with the mock provider, a real `pi-web` started like a user starts it, the
  bridge installed like a user installs it, and 27 assertions covering attach latency, streaming,
  browser prompts, `/new`, `kill -9` and `doctor`.

- **One-command launch.** `pi-web` with no subcommand starts the server and opens the default browser
  straight onto the session list, mirroring how `dsh web` starts the DeepSeek harness. `--no-open` /
  `PIWEB_NO_OPEN=1` opt out; the
  launch degrades to the printed URL when there is no desktop session, no `xdg-open`/`open`, or the
  server is bound to a non-loopback address. The CLI is now `pi-web` (with `piweb` kept as a
  compatibility alias), and `pi-web help`, `--help` and `--version` were added.
- **`pi-web` launches the same way `dsh web` does, from anywhere npm puts it.** `bin/pi-web.mjs` was
  rewritten as an install-anchored launcher (reverse-engineered from the shipped
  `@deepseek-ai/dsh@0.2.2-rc.1` launcher and `@deepseek-ai/dsh-web-app`; findings in
  `docs/research/dsh-web-launch.md`): it resolves its entry from its own URL so the caller's cwd
  never matters, checks `engines.node` before touching app code, boots the compiled `dist/main.js`
  in-process (signals and exit codes stay owned by the server) and falls back to the TypeScript
  sources through `tsx` in a checkout, and turns every startup failure into one `pi-web: ...` line
  instead of a stack (`PIWEB_DEBUG=1` restores the stack). Also `--port 0` (OS-picked port, announced
  in the banner and admitted by the Host/Origin fences), a plain-language report when the port is
  already in use or needs privileges, a warning for plain-HTTP non-loopback binds, a skipped browser
  handoff when launched over SSH, an error for mistyped flags, and updated `--help` covering every
  serve flag and `PIWEB_*` variable. `npm run package:smoke` now packs, installs into a fresh global
  prefix, and asserts the whole command surface from an unrelated directory.
- GitHub Actions CI (`npm run typecheck`, `npm run test:unit`, `npm run build` on Node 22.19 and 24.x,
  with the client bundle uploaded as an artifact).
- A separate advisory e2e workflow that runs the full-stack smoke against pi 1.5.0 and records the
  four currently-known failures instead of hiding them.
- `SECURITY.md` with the supported-versions table, private disclosure route, and an explicit statement
  of what the server enforces and what its trust model does and does not promise.
- `docs/SECURITY_REVIEW.md`: dated review of the committed tip, including findings already resolved
  and lower-priority hardening notes.
- `CONTRIBUTING.md` with verified setup commands, repository map, test matrix, conventions (including
  why reads must never call `SessionManager.open()`), and a troubleshooting table.
- Issue templates (bug report, feature request) and a pull-request template that require real evidence.
- `CODE_OF_CONDUCT.md` and `.editorconfig`.
- Unit-suite goldens pinning the vendored OKHSL math against the upstream reference implementation.
- **The README visuals now show the redesigned client.** `docs/assets/screenshot-hero.png` (the start
  screen), `screenshot-main.png` (a live session with an expanded Edit diff and a controllable composer)
  and `screenshot-dark.png` (the same session mid-turn in the dark theme, `Steer` and `Follow-up` offered)
  were re-captured from the rebuilt bundle at 1600x1000 against the synthetic `/tmp/lightlog` fixture;
  `docs/DEMO_CAPTURE.md` §0 reproduces every one of them.

### Removed

- **The login page is gone — not disabled, deleted.** Opening the UI drops you on your chats. The client
  no longer ships a `Login` component, a bootstrap-code field, a `sign in`/`sign out` affordance or the
  `#code=…` handoff; `boot()` now just contacts the server and renders. Server-side, the one-use
  bootstrap-code machinery was removed with it: `/api/v1/auth/exchange`, `/api/v1/auth/login`,
  `/api/v1/auth/logout`, `AuthService.mintBootstrapCode()` / `exchangeBootstrap()` / `logoutWeb()` /
  `logoutAllWeb()`, the `bootstrap_codes` table (dropped on migrate), `BootstrapExchangeSchema`,
  `BOOTSTRAP_CODE_TTL_MS`, and the `pi-web mint-code` and `pi-web logout-all` commands.
- In place of a login, the request pipeline issues an anonymous browser session (`HttpOnly`,
  `SameSite=Strict`, host-only, 30-day idle pruning) on the first `/api` call that has no cookie and no
  bearer token. Everything that is not a login still applies: Host allowlist, `Origin` allowlist and
  double-submit CSRF on mutations, strict CSP and friends, per-principal rate bucket, and no CORS on
  credentialed reads. Anyone who can reach the bound address can drive the allowlisted workspaces, so
  the default bind remains loopback — see `SECURITY.md`.

### Changed

- **The web front end was rebuilt from the ground up.** The previous custom UI is gone; `packages/client`
  is now a structured app (`styles/`, `ui/`, `features/`, `lib/`) whose layout, spacing, type, icons,
  menus, dialogs, toasts, tooltips and light/dark palettes follow the reference harness interface that
  `dsh web` ships — ported from the token and component CSS of the installed
  `@deepseek-ai/dsh@0.2.2-rc.1` package (`docs/research/`), including its radii, hairline borders,
  elevation, disclosure rows, composer card metrics and the `680…920px` chat-column formula.
  Nothing talks to the reference backend: every control is wired to pi-web's own REST + SSE surface —
  workspace allowlist and folder picker (`GET /api/v1/browse`), session list and search, hero
  "pick a workspace, type, send" flow that starts a managed `pi`, streaming previews, thinking and tool
  disclosures with diffs, model / thinking / delivery (steer, follow-up) menus, abort, compact, rename,
  image attachments, extension dialogs, the trajectory tree, workspace file browser, context and usage
  meters, the session-log download, settings (theme, font sizes, panel width, grouping, timestamps,
  Enter-to-send) and the collapsed rail with responsive narrow-window behaviour. Keyboard:
  <kbd>Ctrl</kbd>+<kbd>K</kbd> composer, <kbd>B</kbd> sidebar, <kbd>N</kbd> new session, <kbd>.</kbd>
  abort, <kbd>R</kbd> rename, <kbd>,</kbd> settings, <kbd>Alt</kbd>+<kbd>↑/↓</kbd> switch session.
- `GET /api/v1/browse?path=…` was added server-side for that folder picker: it lists only directory
  entries (`name`, `kind`) inside the allowlist rules, never file contents.

- Server construction passes `new LogController({ disableRequestLogging: true })` instead of the
  deprecated top-level `disableRequestLogging` flag, so booting pi-web no longer prints a
  `FSTDEP023` deprecation line ahead of the launch banner. Per-request access logging stays off.
- The README now leads with the main UI instead of the login card: `docs/assets/screenshot-main.png`
  shows a session transcript (session list, thinking, tool calls with results, markdown, the follow-up
  commit) captured from a real local build at 1600x1000 @2x against synthetic demo data. No login-page
  image is shipped any more: `docs/assets/screenshot-login.png` was deleted, and the social preview was
  re-rendered around the new still. `docs/DEMO_CAPTURE.md` §0 records how both are reproduced.

### Fixed

- **macOS: the folder a user clicked could not be opened, and the reason was unreadable.** `readdir` on
  `~/Documents`, `~/Desktop`, `~/Downloads` and friends answers `EPERM` until the app that launched the
  server is granted Files and Folders, and the picker answered that with a `500 {"code":"EACCES"}` and a
  toast quoting node. An unopenable level now answers `directory_unreadable` (400) with the reason, the
  dialog shows it in its own alert strip, and a denial that looks like macOS privacy says so and names the
  setting. Choosing that folder still works — listing it is not required to add it — and the selection
  survives the failed listing instead of silently falling back to the parent you never clicked.
- **macOS: browsing a symlink no longer teleports you.** The picker canonicalised every level, so
  `/tmp/x` came back as `/private/tmp/x` and an iCloud-redirected or symlinked folder registered a
  workspace under a path nobody typed. The host resolves and never canonicalises now, and a symlink to a
  directory is offered under its own name.
- **Windows: separators, roots and labels.** Paths are built with the host's own path module (never string
  concatenation), `C:x` and `/foo` are refused as not fully qualified the way the reference refuses them,
  a drive root's parent is a "This PC" level listing the drives that answer within 250 ms (on POSIX
  pressing up reaches `/`; a drive root has no parent, so `D:\` was otherwise unclickable), and the
  workspace label stops being the entire path now that `basename()` knows `\`.
- **A folder full of files could hide every folder in it.** Files were listed, then filtered out client
  side, and counted toward the 2000-entry slice — so a mostly-files directory could show "no folders" and
  still claim the listing was complete. Directories only now, bounded at 1000 name-sorted rows, and a cut
  is announced (`Too many folders to list; only the beginning is shown.`).
- **Dialogs stole focus mid-task.** `Dialog` re-armed its autofocus timer whenever the parent re-rendered
  (which is constantly while the picker is open) and its selector matched the first button in document
  order, i.e. the close `✕`. The effect now runs once per dialog and prefers `[data-autofocus]`.
- **Escaping a nested dialog escaped the outer one too.** The picker's "New folder" prompt is modal over
  the picker; the picker now ignores its own dismissal while that prompt, or an in-flight pick, holds it.

- **A fresh `npm i -g @piwebui/pi-web@latest` could not list chats, open a project, or start a browser
  chat** — the three things the README tells you to do first. The published server resolved the pure
  read worker and the managed host with sibling-path arithmetic, so both files were missing from the
  only layout users actually install into; the worker's load error exited silently, and the boot error
  arrived under a timestamp the UI renders as `…` with no error anywhere. Scripts now resolve through
  Node module resolution with layout fallbacks, a dead worker fails fast with its exit code and
  stderr tail in the server log, and a failed boot says what failed in the sidebar, the right panel
  and the terminal. `npm pack` also shipped no client at all (`404` at `/`); the packed tree now
  builds and stages `client-dist`, and `npm run package:smoke` packs the tarball, installs it into a
  throwaway prefix and refuses to pass unless the real thing lists chats, opens files and boots a
  managed host.
- A bridged terminal leaked one live preview per streamed chunk — duplicate assistant rows, each
  stuck on "working", replayed on every reload, growing unbounded — because previews were keyed on
  message-object identity and pi hands a fresh object per token. Both bridge implementations are
  fixed, with regression tests that reproduce the exact shape.
- `/raw` truncated to the page cap and answered `200`, so a "Download log" could silently be a
  partial file; a partial answer now says `Content-Range`. `/files?path=` accepted absolute paths
  outside the workspace (403 for `/etc`, 500 for nonsense) and answered a machine-root listing with
  a bare `[]`; missing paths now `404` and say why, and an orphaned or vanished session file reports
  the path instead of a blank panel or the neighbour's history.
- Model and thinking were blank for every session until its first run, cold file reads ignored a
  model/thinking that was already set, and an invalid bearer token silently downgraded the request to
  an anonymous session instead of answering `401`.
- Directory picker: the path you picked was not shown in the breadcrumb and a failed path vanished
  without a trace. Unreachable row actions (Rename, Copy path, Session options, Remove, Download log)
  are focusable. A fresh session is titled from its first prompt immediately.
- Added `DELETE /api/v1/sessions/:key` with the hidden-chat list and `pi-web hidden` / `unhide`, so a
  mistaken chat can be removed; abandoned never-run managed sessions release their host instead of
  holding capacity until the next restart.
- Honesty in the surfaces clients read: unmapped runtime events were dropped into a frame name no
  client subscribes to and are now `notice` frames the UI shows; `mode` asks the filesystem before
  declaring a session `no file`; `entryCount` no longer means the page size; `/meta` publishes the
  rate limit it actually enforces; the idempotency error states the rule actually enforced; the busy
  answer names the holding controller and its lease; stale runtime state no longer renders as a
  spinner, and a live-but-unrun session says "Ready" instead of "Unknown".
- Test suites that could not be trusted: `npm run smoke` exited `1` on every run (it asserted a field
  the endpoint never returns), its "flaky" parallel-prompt row was the harness trying to acquire a
  session it already controlled, and `npm run p0:verify` rewrote tracked files on every run. The
  harnesses now kill every process group they start and fail the run on a survivor; bridge coverage
  gained the preview-leak row, a kill during a dialog, and a model override on the bridge path.
- Storage and CLI hygiene: the store and data dir are no longer group/world-readable, `pi-web doctor
  --json` answers JSON on its failure paths, the CLI no longer prints the bridge token or positions
  its `serve` flags wrongly, and Pi's own `settings.json` entry for the bridge is replaced on
  reinstall instead of duplicated.
- **`latest` was not one release.** All four publishable packages answered `0.1.0` for `latest`, but
  three of them were published on 2026-11-07 and `@piwebui/pi-web-bridge@0.1.0` on 2026-11-08 — the
  one-time hand-publish that had to happen to register a trusted publisher reused a version number a
  released sibling had already used. A user who followed the README got `@piwebui/pi-web@0.1.0`, a
  server with no terminal bridge at all (zero references to `bridge.json`; its pairing command was
  the legacy `print-bridge-command`), next to the new dial-mode bridge that dials a socket that
  server never opens: the bridge installs, loads, and the terminal `pi` never appears. Same version
  number, 18 hours apart, invisible to every per-package check. `npm run verify:published -- --all`
  now requires the whole set to be on one version *and* that version to have been published inside
  one window (`--set-window-hours`, 6h default), as its first registry check; cutting `v0.1.1`
  moved every tag together. Rule for the future: a bootstrap hand-publish gets a scratch version
  (`0.0.0-stage`), never a number a released sibling used.
- **The published CLI was missing subcommand coverage of the command gate.** `0.1.0` dispatches only
  `serve, allow, workspaces, mint-code, mint-token, revoke-token, logout-all, install-bridge,
  print-bridge-command`, so every `pi-web doctor` / `install-extension` / `pair` /
  `rotate-bridge-token` / `trust-runtime` in the README landed on usage text — and `0.1.0` answered
  an unknown subcommand with exit **0**, so it looked like it ran. `npm run check:cli` now fails when
  a fenced docs block runs a subcommand the dispatcher does not have, and `npm run verify:published`
  checks the subcommands the docs promise against the *published* `dist/main.js` (self-disabling once
  main's manifests run ahead of the release, so normal main-vs-stable lead is never read as drift).
- **Nothing watched `latest` after a release shipped.** The morning's fix was real and the report
  stayed open for a day anyway, because the tree was correct and the registry was not, and no job
  compared them. `.github/workflows/registry-drift.yml` runs daily (and on demand, and whenever the
  release scripts change): `check:cli` plus `verify:published --tag latest --all --settle 300`, then
  prints what every package's `latest` resolves to, so the next occurrence is a red run rather than
  another user's bug report.

- **`npm install -g @piwebui/pi-web` installed no `pi-web` command.** The install finished (176
  packages, no error) and then `pi-web` was `command not found`, because the artifact on the `latest`
  dist-tag — `0.1.0` — was published from a manifest whose `bin` map had been renamed to `piweb`
  only, while every document tells people to type `pi-web`. npm versions are immutable, so `0.1.0`
  cannot be repaired: the manifests are bumped to `0.1.1` and `latest` moves by cutting `v0.1.1`
  (`npm i -g @piwebui/pi-web@next` already gives the working command). Two gates keep the two sides
  of the promise together from here: `npm run check:cli` fails a build when the shipped `bin` map and
  the commands used in the docs disagree (`scripts/cli-names.mts` is the one list), and
  `npm run verify:published` installs what the *registry* serves into a scratch global prefix and
  runs `pi-web --version` / `piweb --version`, so a release that would leave users without the
  documented command fails CI instead of shipping. `release.yml` now runs both.
- **The README blamed `PATH` for that symptom.** The "command not found" note only described the
  `PATH` cause, which sends people into their shell config for a version problem; it now has you ask
  npm what the installed artifact declares (`npm view @piwebui/pi-web bin`, `piweb --version`) first,
  and records the `EEXIST` collision with the unrelated unscoped `pi-web` package.
- **The hero folder selector was floating in the wrong place.** `--dsh-composer-hero-padding` was
  referenced in `.pw-hero__stack` / `.pw-hero__body` but never defined, which made the whole `calc()`
  invalid and dropped its `max-width`: the workspace chip stayed pinned to the far left of the column
  while the composer card stayed centred (a 190 px gap at 1600 px, 350 px at 2000 px). The hero width is
  now one derived token (`--dsh-hero-stack-width`) built from the defined side clearance, and the chip
  sits 4 px inside the card edge at every viewport width, as in the reference.
- **Resizing the window to a phone width blanked the app.** `collapsed = !phone && (... || useNarrow())`
  short-circuited a hook call, so the hook count changed the moment `phone` flipped and React threw
  `Cannot read properties of undefined (reading 'next')` while unmounting the tree. Hooks are now called
  unconditionally.
- **Nothing fitted a small window.** The chat column floor is now `min(680px, 100%)`, the composer card,
  the hero stack and the transcript clamp to their container, dialogs cap at
  `min(760px, 100%)` and `100dvh - 48px` with their body scrolling internally, and the settings pane
  stacks its tab rail above the controls below 640 px. Measured 360/390/430/640/820/1024/1280/1470/
  1920/2560 px in hero, session and settings states: no horizontal overflow, no element outside the
  viewport, hero gap 4 in every case.
- Under 640 px the sidebar is now a drawer (scrim, close button, closes on session pick) instead of a
  56 px rail eating a third of the screen, and the right panel opens as a side sheet so the Workspace
  files / Trajectory / Context tabs stay reachable on a phone. <kbd>Ctrl</kbd>+<kbd>B</kbd> toggles the
  drawer there and the rail elsewhere.

- **Commands could be silently dropped once a control grant expired.** A grant lives for a minute, but
  the client kept using the cached secret, so anything typed after that failed envelope validation
  (`controlSecret: must not have fewer than 8 characters`). The client now renews the grant before it
  lapses, renews defensively before every dispatch, and treats a rejected secret the same way as
  `stale_control`: re-acquire and retry once.
- **`ownerChanged` wiped the session's status.** That event is routine while a managed `pi` boots, and
  clearing `status` left the composer without capabilities, so the first prompt of a new session was
  never sent. The event now just triggers a re-read of `GET /api/v1/sessions/:key` (same for `resync`
  and `hostExited`).
- **A failed command reported nothing.** `POST …/commands` only acknowledges the envelope; the owner's
  answer arrives on the operation receipt. The client now polls `GET /api/v1/operations/:id` and shows
  `failed` / `unknown` / `cancelled` results as an error toast and a composer notice (for example
  "session is streaming; use steer or follow-up"), and marks successful ones on the operation state.
- **The prompt you had just typed appeared twice** — once as the live user preview and once as the
  committed entry — because user previews never carry `mappedEntryId`. Previews are now deduplicated
  against committed messages by role and text.
- **The server could take itself down when a settled managed host was reaped.**
  `scheduleSettledCleanup()` dereferenced `state.queue` unconditionally and threw inside a timer, which
  is an unhandled exception; the cleanup body is now guarded and a failure is logged instead of fatal.
- The collapsed sidebar kept the session-list controls (search, sort, add) overflowing its 56px rail and
  left the account row floating mid-rail; the rail now shows the mark (which expands the sidebar), new
  session, the panel icons and the account row at the bottom, matching the reference.

- `e2e/server-smoke.mts` assumed pi always writes message content as a block array and threw
  (`content.filter is not a function`) as soon as the flow reached the transcript checks; it now reads
  text from a string or a block array, which is what unblocked `S13` and `S18`.
- **Theme colors rendered as clipped primaries.** `chromaStops()` in the vendored OKHSL code was
  missing the outer reciprocal on both harmonic means relative to `pi-tui`'s reference implementation,
  which inflated `c0`/`cMid` and pushed every saturated color out of gamut. `okhsl(40 10% 90%)`
  rendered `#ff0000` instead of `#e7e1df`; `okhsl(265 40% 60%)` rendered `#ff00ff` instead of
  `#7b90bf`. Now byte-for-byte identical to upstream across a 19,656-point grid, and pinned by goldens.
- Stray `true/` SQLite artifact and the `.plan-review-backup-*` snapshot are no longer tracked, and
  database files are ignored so a mistyped `--data-dir` cannot commit one again.
- Stale documentation pointer to a `scripts/contrast-audit.ts` that does not exist in this repository.

### Known state of the test suites

Honest, as of this commit, on Node 24 with pi 1.5.0 installed:

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run test:unit` | pass (9 tests) |
| `npm run build` | pass (client bundle, no source maps) |
| `npm run smoke` | **21/23** on 2026-11-07 after the login removal (`S1`–`S4b` now assert the login-free contract). `S17` and `S20` still fail and are open work: `S17` lost one of four concurrent hosts to a control-acquire timeout, `S20` asserts an `entries` field the stats route has never returned (it answers `totalEntries`). |
| `npm run p0:verify` | not re-run in this pass; see `docs/CAPABILITY_MATRIX.md` for its last recorded result |
