# pi-web

**A local-first web UI for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): browse the sessions your `pi` CLI writes, and drive sessions from the browser.**

![npm](https://img.shields.io/npm/v/@piwebui/pi-web)
![license](https://img.shields.io/badge/license-MIT-green.svg)
![node](https://img.shields.io/badge/node-%3E%3D22.19-blue.svg)
![CI](https://github.com/h8ntome/piwebui/actions/workflows/ci.yml/badge.svg)
![platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux-lightgrey.svg)

pi-web renders and relays. **pi stays the only agent runtime and the only writer of session files** —
pi-web never executes tools, never talks to a model provider, and never writes session JSONL. Control
reaches pi through pi's own interfaces: an opt-in bridge extension for the `pi` you already have open in
a terminal, or managed `pi` SDK child processes for sessions you start in the browser.

![pi-web viewing a session: the workspace's session list on the left; on the right, pi thinks, reads and greps the code, edits the fix, runs the tests and commits it](docs/assets/screenshot-main.png)

*Viewing a session in an allowlisted workspace — synthetic demo data, real UI.*

## Install

```bash
npm install -g @piwebui/pi-web
```

Then point it at a private data directory:

```bash
piweb serve --data-dir ~/.pi-web
```

The terminal prints a **one-use login code** (2-minute TTL). Open <http://127.0.0.1:4319/>, paste it,
and you are in.

Allow the project directories whose sessions you want visible — nothing is scanned by default:

```bash
piweb allow /absolute/path/to/your/project --data-dir ~/.pi-web
piweb mint-code --data-dir ~/.pi-web      # another login code
```

Working from a checkout instead:

```bash
npm ci
npm run build
./packages/server/bin/pi-web.mjs serve --data-dir ~/.pi-web
```

Requirements: Node.js **≥ 22.19**, and `pi` **1.5.0** on the machine. pi-web is pinned to that pi
version and fails closed: if the resolved pi is not the validated one, runtime-facing features are
disabled rather than guessed at.

## What you can do

- **Browse real session history** — transcripts, tool calls and results, thinking, tree and branch
  context, statistics. Reads run in an isolated worker restricted to the directories you allowlist.
- **Control a terminal `pi` from the browser.** Start that `pi` with the bridge extension and, while it
  is idle at a prompt, you can prompt, steer, follow up, abort, switch model and reasoning, rename,
  compact, and inspect tree/context/snapshot — while your keyboard in the terminal always wins.
- **Create sessions in the browser.** They run in managed `pi` SDK child processes, one per session,
  and hand back cleanly: the UI waits for the host to exit and release the file before it offers
  `pi --session /abs/path/to/session.jsonl`.
- **Close the tab.** Commands are fire-and-track: a run continues when the tab closes or the network
  drops. Reconnecting replays a bounded window, or resyncs from a fresh snapshot when the window is
  gone. There is no inactivity timeout that kills runs.
- **Reach it from your phone** over a mesh VPN such as NetBird, with TLS at a reverse proxy in front of
  the loopback server.
- **Script it** with long-lived bearer tokens: `piweb mint-token` / `piweb revoke-token`.

## How it is put together

| Package | Role |
| --- | --- |
| `@piwebui/pi-web` | the server and the `piweb` CLI |
| `@piwebui/pi-adapter` | everything that touches pi: version gate, pure read worker, managed host, terminal bridge |
| `@piwebui/shared` | types, schemas, wire frames, colour math |
| `@piwebui/client` | the React client, built into `@piwebui/pi-web` |

Session reads happen in a separate **read worker** that only sees allowlisted roots and opens files
read-only. Live state reaches the browser over SSE with replay and resync. Commands are validated
against versioned schemas before they reach pi.

## CLI

```
piweb serve   [--port 4319] [--bind 127.0.0.1] [--data-dir DIR] [--host-allow h1,h2]
              [--agent-dir DIR] [--tls-cert F --tls-key F]
piweb allow <absolute-dir>              # allowlist a workspace
piweb workspaces                        # list allowlisted workspaces
piweb mint-code                         # one-use browser login code
piweb mint-token [--name n]             # long-lived API bearer token
piweb revoke-token --id ID
piweb logout-all                        # drop all browser sessions
piweb install-bridge [--agent-dir DIR]  # install the bridge as a pi user extension
piweb print-bridge-command              # exact env + `pi -e` command for a terminal session
```

## Security

- Binds `127.0.0.1` by default. A non-loopback bind requires an explicit `--bind` plus matching
  `--host-allow` entries, and the Host allowlist is built from server configuration rather than from
  request data.
- Every `/api` route needs a session cookie or bearer token. Only the one-use bootstrap exchange and
  static boot assets are public. Login codes expire in 2 minutes and are stored hashed, as are cookies,
  CSRF values and API tokens.
- Mutations require the CSRF header and a trusted `Origin`. Cookies are `HttpOnly`, `SameSite=Strict`
  host-only, and `Secure` whenever the request arrives over TLS.
- Responses carry a strict CSP, `nosniff`, `X-Frame-Options: DENY` and `referrer-policy: no-referrer`;
  markdown is sanitized; payloads and page sizes are bounded with explicit errors.
- Logs are structured and content-free: prompts, tool output and secrets are not logged.

A control grant is equivalent to typing in that project's terminal — pi-web deliberately does not
re-implement pi's own permissions. Read [SECURITY.md](SECURITY.md) for the full model and how to report
a vulnerability privately.

## Remote access

Keep pi-web on loopback and terminate TLS with a proxy bound to your mesh interface (NetBird, Tailscale),
passing `Host` and `Origin` through:

```bash
piweb serve --host-allow "100.0.0.5:8443,127.0.0.1:4319"
```

Do not put pi-web behind public ingress.

## Development

```bash
npm ci
npm run build          # typecheck all packages, compile them, build and stage the client
npm run test:unit      # unit suite
npm run smoke          # full-stack HTTP/SSE smoke against a real pi
npm run p0:verify      # capability matrix
npm run dev:server     # tsx watch on 4319
npm run dev:client     # vite on 5199, proxying /api
```

Full setup, repository map, conventions and troubleshooting: [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

| Document | Contents |
| --- | --- |
| [CONTRIBUTING.md](CONTRIBUTING.md) | development setup, layout, testing, conventions |
| [SECURITY.md](SECURITY.md) | what the server enforces, trust model, private disclosure |
| [CHANGELOG.md](CHANGELOG.md) | release history and known state |
| [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md) | every runtime claim and its verification |
| [docs/CHECKS.md](docs/CHECKS.md) | dated record of what has been verified |
| [MAINTAINERS.md](MAINTAINERS.md) | triage rhythm and the release process |

## Contributing

Issues and pull requests are welcome. Start with
[good first issues](https://github.com/h8ntome/piwebui/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22),
read [CONTRIBUTING.md](CONTRIBUTING.md), and ask questions in
[Discussions](https://github.com/h8ntome/piwebui/discussions).

## License

MIT — see [LICENSE](LICENSE).

pi-web is an independent project. It drives [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
and vendors a small amount of MIT-licensed math from `pi-tui`, with attribution preserved in
`packages/shared/src/okhsl.ts`. It is not part of pi, and it is unrelated to other packages named
`pi-web` published independently on npm.
