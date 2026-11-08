# @piwebui/pi-web-bridge

Let a **terminal** [`pi`](https://github.com/badlogic/pi-mono) session be seen and driven from
[pi-web](https://www.npmjs.com/package/@piwebui/pi-web) — live, streaming, and with nothing to
configure.

```bash
pi install npm:@piwebui/pi-web-bridge     # once, ever
```

That is the whole installation. Start `pi-web` in one terminal, `pi` in another, open the URL
`pi-web` prints, and that terminal appears as **Terminal (bridged)** within a couple of seconds —
thinking, tool calls, tool output and the answer stream into the browser token by token, and the
browser can send prompts, steer a running turn, rename, switch model/thinking level and abort,
while the terminal keeps working normally.

`/new`, `/resume`, `/fork` and `/reload` inside `pi` keep all of that working with no further action.

## What it actually does

The extension runs *inside* your terminal `pi` process. It finds the running pi-web server through
its descriptor (`~/.pi-web/bridge.json` by default), dials the server's Unix socket, streams this
`pi`'s live events out, and executes the commands that come back in.

```
pi (your terminal) ── pi events ──▶ bridge ── JSONL over a unix socket ──▶ pi-web ──▶ browser
                     ◀── prompt / abort / rename / setModel / setThinking ───
```

It uses only Pi's public extension API. It does not patch Pi, read another process's memory,
attach a debugger, write session files, or talk to a provider. It has **zero dependencies** (Node
builtins only), so it loads even when Pi is offline.

## Nothing to configure — and what it reads if you do want to

Resolution order, first usable hit wins (every step is reported by `/piweb`):

| Step | Source |
| --- | --- |
| 1 | `PIWEB_BRIDGE_DISABLE=1` — off, silently, no socket, no retry |
| 2 | `PIWEB_BRIDGE_FILE=/path/bridge.json` |
| 3 | `PIWEB_BRIDGE_SOCKET` + `PIWEB_BRIDGE_TOKEN` (inline; containers, tests) |
| 4 | `$PIWEB_DATA_DIR/bridge.json` |
| 5 | `$PI_CODING_AGENT_DIR/../pi-web/bridge.json` |
| 6 | `~/.pi-web/bridge.json` — the normal case |
| 7 | `~/.pi-web/servers/*.json` — pointers to other servers (multi-server fan-out) |
| 8 | legacy `PIWEB_BRIDGE_DIR` + `PIWEB_BRIDGE_TOKEN` (pre-1.0 registry mode, one release) |

Other knobs, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIWEB_BRIDGE_MODES` | `tui` | which run modes get bridged; `pi -p`, JSON/RPC and pi-web's own managed host stay unbridged |
| `PIWEB_BRIDGE_MAX_SERVERS` | `4` | how many pi-web servers one `pi` will serve at once |
| `PIWEB_BRIDGE_DISABLE` | – | `1` turns the bridge off for this process |
| `PIWEB_BRIDGE_DEBUG` | – | `1`/`stderr` or a file path: log what the bridge decided |
| `--no-pi-web-bridge` | – | per-invocation opt-out flag |

Inside `pi`:

* the footer shows `● pi-web · 1 viewer · <serverId>`;
* `/piweb` prints the session, the viewers, dropped-frame counts, or **why it is not connected**
  with the command that fixes it.

## What the browser can *not* do from a terminal session (honest limits)

| Limit | Why |
| --- | --- |
| Answer a terminal extension dialog from the browser | Pi's public API exposes no response handle for another extension's dialog (`ui_prompt_start/end` carry kind/title only), so it is shown as observed with "answer in the terminal" — never auto-approved |
| List or clear the message queue | not exposed by Pi; only a "pending" flag |
| Expand slash commands / `@paths` in browser text | opt-in only (`expandCommands`), because expanding dispatches extension commands from browser input |
| Show the exact provider request | Pi hooks/routing are below the extension API; what you see is labelled a runtime preview |

## Security model, in one paragraph

The bridge listens on no network port: one Unix socket owned by the pi-web server, `0600` in a
`0700` directory, authenticated by a token that only ever lives in that `0600` descriptor. **Same
uid is the trust boundary**: anything running as you that can read `~/.pi-web/bridge.json` can
register a runtime and push prompts into a `pi` it can name. Beyond that floor, the server
*attests* every bridge — the claimed `pid` must be a live process that looks like the Pi CLI and
that started when it claims it did — and keeps a runtime list you can revoke
(`pi-web revoke-runtime <id>`). Node exposes no `SO_PEERCRED` accessor, so peer credentials are
not part of this design; process attestation plus file modes are. Set
`PIWEB_BRIDGE_DISABLE=1` if you do not want any terminal bridged.

## Uninstall

```bash
pi remove npm:@piwebui/pi-web-bridge     # or: rm ~/.pi/agent/extensions/pi-web-bridge.js
```

Nothing else is left behind: the bridge writes no files, no sockets and no pid files of its own.
