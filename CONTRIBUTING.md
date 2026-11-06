# Contributing to pi-web

Thanks for taking the look. pi-web is small, local-first, and deliberately opinionated about one thing
above all: **pi is the only runtime and the only writer of session files.** Most design debates in the
codebase come back to that sentence, so reading it once before you start will save you time.

## Before you open anything

- Check the open issues and the
  [capability matrix](docs/CAPABILITY_MATRIX.md), which lists every claim the README makes and whether
  it is actually verified. If your idea touches runtime behaviour, the matrix is the contract.
- For anything larger than a typo or a small bug fix, open an issue first. A short paragraph is enough.
- Security issues are handled privately — see [SECURITY.md](SECURITY.md), not the issue tracker.

## Development setup

Requirements: **Node.js >= 22.19.0** (the `engines` field is enforced) and, if you want to exercise the
runtime features, a local install of **pi 1.5.0**. pi-web is pinned to pi 1.5.0 and fails closed: if
the resolved pi version is not the validated one, runtime-facing endpoints are disabled rather than
guessed at, and some checks will report themselves as skipped rather than failed.

```bash
git clone https://github.com/hadihanafpi/pi-web
cd pi-web
npm ci                 # reproducible install from package-lock.json
npm run build          # typecheck all four packages + build the client
```

Run the server against a throwaway data directory so you never touch your real session state:

```bash
./packages/server/bin/pi-web.mjs serve --data-dir /tmp/pi-web-dev
```

It prints a one-use login code (2-minute TTL). Open <http://127.0.0.1:4319/>, paste it, and you are in.
Add a workspace whose sessions you want visible — nothing is scanned implicitly:

```bash
./packages/server/bin/pi-web.mjs allow /absolute/path/to/a/project --data-dir /tmp/pi-web-dev
```

Day-to-day development uses two processes:

```bash
npm run dev:server     # tsx watch on the server (4319)
npm run dev:client     # vite on 5199, proxying /api to 4319
```

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared/` | Types, zod schemas, wire frames, vendored OKHSL/Oklab math. No I/O. |
| `packages/pi-adapter/` | Everything that touches pi: version resolution, the read worker, the managed host, the terminal bridge extension. |
| `packages/server/` | Fastify app: auth, routes, sessions, control grants, SSE hub, CLI entry (`bin/pi-web.mjs`). |
| `packages/client/` | React SPA (Vite, TypeScript). `src/App.tsx` is the transcript and control surface; `src/md.ts` is the sanitize/render pipeline, `src/api.ts` and `src/sse.ts` are the transport, `src/store.ts` and `src/theme.ts` hold state and theming. |
| `e2e/` | Capability matrix, full-stack smoke, fixtures and the mock provider. |
| `docs/` | Capability matrix, the dated verification checklist, architecture and security notes. |
| `scripts/` | Packaging smoke and maintenance helpers. |

Conventions that are worth knowing before your first patch:

- **Untrusted pi data is treated as data, never code.** New read paths go through the read worker and
  must be size-bounded, and anything rendered into the DOM goes through the markdown/sanitize pipeline
  in `packages/client/src/md.ts`.
- **Errors are typed and reported, not swallowed.** The codebase has no empty `catch {}` on purpose; a
  failure that a user can feel must surface as a state the UI can show.
- **Never call `SessionManager.open()` for reads.** It rewrites session files. Reads open originals
  directly in the worker; this is verified in the capability matrix and is easy to regress.
- Keep runtime state in pi or the store, not in module-level globals in the client.

## Testing

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc` across all four packages (the client is checked with `--noEmit`). |
| `npm run test:unit` | Node's built-in test runner: OKHSL parity goldens, NDJSON framing, schemas. |
| `npm run build` | Typecheck plus production client build into `packages/client/dist`. |
| `npm run smoke` | Full-stack HTTP/SSE smoke: boots its own server, mints a code, exchanges the cookie, creates managed sessions, streams, and checks persistence. |
| `npm run p0:verify` | The capability matrix against a real pi, including live bridge sessions under a PTY. |
| `npm run package:smoke` | Packs the workspace and installs it into a throwaway prefix, then runs it. |

Run `npm run typecheck && npm run test:unit && npm run build` before pushing; CI runs the same three.
If your change touches runtime behaviour, run `npm run smoke` too and say in the PR whether your local
result matched the matrix.

**Current state of the suites, so nobody is surprised:** at the time of writing `npm run test:unit`
(9 tests) and `npm run build` pass, and `npm run smoke` reports **18/22** — `S13` (prompt/reply
persistence), `S17`/`S18` (four parallel managed sessions) and `S20` (stats through the read worker)
are known-failing on the committed tip and are tracked as open work, not something your patch broke.
Treat those as pre-existing unless your diff touches them, and do not add new failures.

No real model provider is contacted by any test: model calls in tests go to a deterministic local mock
provider (`e2e/lib/mock-provider.ts`), so no tokens are spent and runs are reproducible.

## Style

- TypeScript, ESM, 2-space indent, no semicolon changes for fun; formatting is whatever `tsc` and the
  existing files already agree on. There is no prettier config on purpose.
- Prefer small modules with explicit types over clever inference at boundaries; zod validates at the
  edges, internally use real types.
- Comments explain *why*, especially where a constraint comes from pi itself (the codebase is full of
  short notes about pi behaviour that is not obvious, like `ack_seq` ordering or `SessionManager.open`
  rewriting files).
- Do not add a dependency to ship a few lines of logic. Dependencies are pinned to exact versions.

## Pull requests

1. Branch from `main`: `git checkout -b fix/session-tree-scroll`.
2. One idea per PR. If you noticed three things, that is three branches.
3. Include in the description: what changed, the exact commands you ran, and — for UI changes — a
   screenshot or short recording. The template asks for this.
4. CI must be green. If a check fails for a reason unrelated to your change, say so in the PR rather
   than marking it as skipped.
5. A maintainer will respond within a few days. Unanswered PRs are a bug in the process, not in you —
   bump it.

Merges are squash-merged, so keep commit messages readable but do not agonise over them; the PR title
becomes the log entry and should read like `fix(server): stop SSE replay after resync`, not `wip`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Startup fails with a modern-JavaScript or missing-API error | Node is older than the required 22.19 (`packages/server/src/auth.ts` hashes codes, cookies and tokens with `crypto.createHash("sha256")`, and the suites use the built-in test runner). Check `node -v`; the `engines` field is not decoration. |
| Runtime features disabled, `health` reports an unvalidated pi | Installed pi is not 1.5.0. pi-web fails closed on purpose — update or pin pi. |
| `Host not allowlisted` (403) | You reached the server by a hostname that is not in `--host-allow`. |
| Mutations rejected with 403 `Origin not trusted` | The browser sent an `Origin` that is not in the trusted list (typical when a dev proxy rewrites it). |
| Sessions list is empty | You have not run `pi-web allow <dir>` for that project, or pi has not written a session there yet. |
| Bridge session does not appear | The terminal pi must be started with `-e packages/pi-adapter/src/bridge/extension.mjs` and the printed env; a process started earlier picks it up at the next `/reload`. |
| Port already in use | Use `--port` for the server; the vite dev port is set in `packages/client/vite.config.ts`. |

## Getting help

Use the **Q&A** category in GitHub Discussions for "how do I…" questions and issues for
bugs and feature requests. There is no chat channel. (Discussions must be enabled once in the
repository settings; see `docs/GITHUB_REPO_SETTINGS.md`.)
