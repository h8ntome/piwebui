# Changelog

## 0.1.1

First release of the extracted bridge package (was: `pi-web-bridge.mjs` copied out of
`@piwebui/pi-adapter`).

- **Zero configuration.** The bridge finds its server through `~/.pi-web/bridge.json`
  (or `PIWEB_BRIDGE_FILE` / `PIWEB_DATA_DIR` / a pointer in `~/.pi-web/servers`); no token in the
  environment, no `pi -e <path>`, no `piweb allow`.
- **Dials the server** instead of each terminal opening its own listener, so a `pi-web` that starts
  *after* `pi` is found within the retry window (≤ 15 s) and stale per-runtime sockets/records no
  longer exist to go bad.
- **Process-global hub**: the socket survives `/new`, `/resume`, `/fork` and `/reload`, and every
  command resolves the live `pi`/`ctx` instead of a handle captured by a dead extension instance.
- Streams thinking, tool calls, tool output and the answer with per-runtime `seq`, a bounded replay
  ring (2000 frames / 4 MiB) and an explicit drop policy (previews first, `turn_end` never).
- Identity is Pi's `sessionId`, so a brand-new session is adoptable before its file exists.
- `ctx.ui.notify` + a footer status line + `/piweb` instead of `console.error` inside a TUI.
- Honours `PIWEB_BRIDGE_DISABLE`, `PIWEB_BRIDGE_MODES`, `PIWEB_BRIDGE_MAX_SERVERS` and
  `--no-pi-web-bridge`; keeps the legacy `PIWEB_BRIDGE_DIR`/`PIWEB_BRIDGE_TOKEN` transport alive for
  one release.
