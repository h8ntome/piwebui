# How `dsh web` launches, and what pi-web copies

Research note, 2026-11-07. Question: **what actually happens when you type `dsh web`, and which of
that does pi-web need to reproduce so that `pi-web` is the same one-command launch?**

## Method and evidence

Target: the **shipped** DeepSeek Harness artifacts on this machine, `@deepseek-ai/dsh@0.2.2-rc.1`
(CLI launcher) and its dependency `@deepseek-ai/dsh-web-app@0.2.2-rc.1` (the browser-surface glue).
No DeepSeek source repository was read; everything below comes from the installed artifact.

REA 6.8.0, JavaScript-application route (`analyze_javascript_application`), inert static analysis —
no DeepSeek code was executed:

| Evidence | Target | SHA-256 of target root |
| --- | --- | --- |
| `ev_441f13b0a2433c85aee586fbc262e0f0ed55ac69132064c8f1834e654bf5060a` | `@deepseek-ai/dsh/lib` (bin.js, profile-boot, plugin/dump commands) — 6 modules | `006a662a05e657020a567bf8923468fbca355b07846770ef7991e38c0676ab6f` |
| `ev_232f42716821bf2532efac59815e18eea1c59d911cebd9a06eb98fa315dff402` | `@deepseek-ai/dsh-web-app` (index.js, startup.js, public-url) — 818 graph nodes, 659 relations, 1 `child-process`, 4 `boundary` | `a1d965c2426c24239086e164f983698de010211278c6017b61c72892a4c89a30` |

The raw evidence bundles are analysis output, not project source, so they are not committed
(`docs/research/rea-*.json` is gitignored). Regenerate with:

```bash
DSH=$(npm prefix -g)/lib/node_modules/@deepseek-ai
npx -y rea-agents@6.8.0 analyze-javascript-application "$DSH/dsh/lib" --json \
  --evidence_output /tmp/rea-dsh-cli-launch.json
npx -y rea-agents@6.8.0 analyze-javascript-application \
  "$DSH/dsh/node_modules/@deepseek-ai/dsh-web-app" --json \
  --evidence_output /tmp/rea-dsh-web-app.json
```

REA's own declared limitations apply to every row below: relationships were recovered from inert
syntax, graph coverage is partial, and static structure does not prove runtime execution. Where a
claim needed runtime behaviour (what the terminal prints, in what order), it is corroborated by the
shipped code path that prints it, named by file and line.

## What `dsh web` actually does

1. **A tiny launcher owns almost nothing.** `@deepseek-ai/dsh/lib/bin.js` (254 lines) parses only
   launcher flags — `--profile`, `--from-default-profile`, `--patch`, the three config dumps — and
   hands *everything after them* to the booted application verbatim
   (`passThroughOptions()`, `enablePositionalOptions()`). `dsh web` is sugar for
   `dsh --profile web`, so `dsh web --help` prints the **web app's** flags, not the launcher's.
2. **Lazy boot.** `bin.js` dynamically imports `./profile-boot.js` only for the boot mode
   (`await import(...)`, one import per mode), so `--version`/`--help`/`--dump-config` never pay for
   mounting the app tree.
3. **Install-anchored layout.** Everything resolves from the launcher's own URL:
   `INSTALL_ANCHOR = new URL("../package.json", import.meta.url)`, and the frontend is located with
   `createRequire(import.meta.url).resolve("@deepseek-ai/dsh-web-frontend/package.json")` + `dist/`
   (`dsh-web-app/lib/index.js`, `resolveDistIndex`). The caller's cwd is never a factor — that is
   what makes a globally installed `dsh` runnable from any directory.
4. **Runtime gate and startup diagnostics.** `getDshRuntimeVersion()` prints the version; a failed
   boot raises `StartupError`, which `bin.js` turns into one concise terminal line plus a full
   report saved under `$DSH_HOME/logs/startup-<ts>-<uuid>.log` — the stack never dumps raw on the
   terminal.
5. **The web app's own flags** live in `dsh-web-app/lib/startup.js`: `--host`, `--port`
   (*"pass 0 to let the OS pick a free one"*), `--public-url`, `--trusted-host`, `--tls-cert` /
   `--tls-key` (must be paired), and `--no-open`. Defaults come from the bundle patch
   (`dsh-web-app/cordis.patch.yml`): `host: '127.0.0.1'`, `port: 3080`.
6. **Wildcard binds are refused, not warned about.** `dsh-host-webserver` rejects `0.0.0.0`/`::`
   with "binding every interface would expose remote code execution to the network"; plain HTTP on a
   non-loopback interface prints an exposure warning (`dsh-web-app/lib/index.js`).
7. **Announce, then hand off to the browser.** After the loader tree settles and the required-entry
   audit passes, `dsh-web-app` prints `dsh web: <url>` and, unless told otherwise, opens the
   default browser:
   - the opener is a **separate Node child process** running an inline `--eval` program that calls
     the `open` package — REA records it as the one `child-process` node at `lib/index.js` ~86–98;
   - the child gets `scrubbedParentEnv()`, i.e. harness credentials are deliberately **not**
     forwarded to the browser launcher;
   - a failed opener is not fatal: it prints *"could not open the default browser because …; use the
     dsh web URL printed at startup"*;
   - when the process was launched over SSH (`SSH_CONNECTION` / `SSH_TTY`, `dsh-launch-environment`)
     the browser handoff is skipped entirely, because the only browser that could open is the wrong
     one.

## What pi-web now does about it

| `dsh web` behaviour | pi-web | Where |
| --- | --- | --- |
| One command, no subcommand: `dsh web` | bare `pi-web` serves and opens the browser | `packages/server/src/main.ts` (`runCli`) |
| Thin launcher that owns only layout | `packages/server/bin/pi-web.mjs` parses no app flags at all; it resolves the entry and boots it | `bin/pi-web.mjs` |
| Lazy, install-anchored resolution (cwd never matters) | entry resolved from `import.meta.url`: packed `dist/main.js` in-process, else `src/main.ts` through `tsx` | `bin/pi-web.mjs` |
| Runtime version gate | `engines.node` is read from the installed manifest and checked before any app import, with a "install a newer Node" line instead of a syntax error | `bin/pi-web.mjs` (`checkNode`) |
| Concise startup failure report, no raw stack | `pi-web: <one actionable line>`; `PIWEB_DEBUG=1` restores the stack | `bin/pi-web.mjs` (`die`), `main.ts` (`fatal`) |
| `--port 0` → OS-picked port | same, and the banner announces the port actually bound; the Host/Origin fences are extended to it before any request can arrive | `main.ts` (`boundPort`) |
| Port already busy | one actionable line: `port N … is already in use … pi-web --port 0` | `main.ts` (`EADDRINUSE`, `EACCES`) |
| Wildcard bind rejected / non-loopback HTTP warned | non-loopback plain-HTTP bind prints an exposure warning to stderr; the loopback default and the Host fence are unchanged | `main.ts` |
| Print URL, then open browser | `pi-web listening on http://127.0.0.1:4319` then the opener; failure degrades to the printed URL | `main.ts` (`openBrowser`, banner) |
| SSH launch skips the browser | `SSH_CONNECTION` / `SSH_TTY` skip it and tell you to use `ssh -L` | `main.ts` (`launchedOverSsh`) |
| `--no-open` | same flag, plus `PIWEB_NO_OPEN=1`; `--open` forces the attempt anyway | `main.ts` (`browserOpenBlocker`) |
| Own `open` dependency for the handoff | deliberately **not** added: pi-web shells out to `xdg-open` / `open` / `termux-open` found on `PATH`, keeping the shipped runtime dependency list at fastify + tsx | `main.ts` (`BROWSER_OPENERS`, `findInPath`) |
| Cordis profiles, patch layers, `pnpm` plugin installs, `--public-url`/`--trusted-host` fences | **not copied** — pi-web has no plugin tree to compose; the equivalent of `--host-allow` covers a proxy entry | out of scope |

One incidental cleanup fell out of this: `dsh`'s launch output is quiet, and pi-web's was not —
Fastify 5 printed `FSTDEP023` on every boot. `disableRequestLogging` moved to the documented
`new LogController({ disableRequestLogging: true })`, so the launch banner is the only output
(`packages/server/src/http.ts`).

## What this does **not** establish

- Nothing here was observed by running DeepSeek's code; it is shipped-artifact static structure and
  the code paths that emit the printed lines. REA's graph coverage is partial by declaration.
- The DeepSeek CLI keeps its launcher flag parsing in `commander` with `exitOverride`; pi-web keeps
  its small hand-rolled flag parser. Behavioural parity was reproduced for the flags that affect
  launch (`--port`, `--bind`, `--no-open`/`--open`, TLS pairing), not for every flag dsh accepts.
- `dsh` prints an *authenticated* URL (a connection token folded into it); pi-web has no login, so
  its URL is plain and the browser is trusted by the loopback bind plus the Host/Origin fences.
- Version-specific: everything above was read from `0.2.2-rc.1`. A later harness release may move
  these pieces; the evidence IDs and target digests pin what was actually examined.
- Platform scope actually exercised: the browser handoff here is POSIX-shaped (macOS `open`, Linux/*BSD
  `xdg-open`, Termux `termux-open`). On Windows pi-web reports "no browser opener for win32" and prints
  the URL instead — deliberate, and not tested on a Windows host, unlike `dsh`, which hands off through
  the `open` package.
