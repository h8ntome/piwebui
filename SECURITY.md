# Security Policy

pi-web is a **local-first** browser surface for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
sessions. The design assumption throughout: the machine running pi-web is yours, and anything that can
reach the bound address should be treated as an untrusted network peer unless you explicitly allow it.

## Supported versions

| Version | Supported | Notes |
| --- | --- | --- |
| `0.1.x` (current `main`) | yes | Active development; breaking changes are expected between minors. |
| `< 0.1` | no | Pre-release history; no supported upgrade path. |

Runtime compatibility is pinned and fail-closed: pi-web is validated against **pi 1.5.0** and Node
`>=22.19.0`. If the resolved pi version is not the validated one, runtime-facing features are disabled
rather than guessed at.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

- Email **hadi@hadi.tn** with the subject prefix `pi-web sec`.
- Include: the commit SHA or version, the exact reproduction steps, and what you believe the impact is.
- You will get a human acknowledgement within **7 days** (usually far sooner — this is a small
  volunteer-maintained project, so we promise a real response, not an SLA we cannot keep) and a fixed
  release or a written explanation within **30 days**.
- We will credit reporters who act in good faith, unless you prefer anonymity.

Good-faith research is welcome: probing your own local instance, reading the code, and testing the
auth boundary of a server you run are explicitly fine.

## What the server enforces today

Every item below is implemented in `packages/server/src/http.ts` and `packages/server/src/auth.ts`
and can be read directly rather than taken on faith.

**Network exposure**

- Binds `127.0.0.1:4319` by default (`DEFAULT_BIND` / `DEFAULT_PORT` in `packages/shared/src/constants.ts`).
- The `Host` header is checked against an allowlist that is built from server configuration, not from
  request data, which blocks DNS-rebinding against a loopback listener.
- Non-loopback binds require an explicit `--bind` plus matching `--host-allow` entries; remote access
  is documented as a TLS-terminating reverse proxy on a trusted mesh (NetBird), never public ingress.

**Authentication and sessions**

- Every `/api` route requires a session cookie or a bearer API token. Only the one-use bootstrap
  exchange and static boot assets are public.
- Browser login uses a **one-use bootstrap code** with a 2-minute TTL (`BOOTSTRAP_CODE_TTL_MS`);
  codes are stored as SHA-256 hashes, never plaintext (`bootstrap_codes.hash`).
- Session cookie `piweb_session` is `HttpOnly`, `SameSite=Strict`, host-only (no `Domain`), and `Secure`
  whenever the request arrives over TLS (`x-forwarded-proto` is honoured for the flag only).
- Long-lived scripting tokens (`mint-token` / `revoke-token`) are stored hashed (`principals.token_hash`).
- A per-principal token bucket (600 requests/minute, non-SSE traffic) limits brute-force and runaway clients.

**Request integrity**

- All mutations require the `x-piweb-csrf` header to match the session's stored CSRF hash, and a
  trusted `Origin` when one is present.
- Response headers on every route: `content-security-policy`, `x-content-type-options: nosniff`,
  `x-frame-options: DENY`, `referrer-policy: no-referrer`.

**Read-path isolation**

- Session file reads, entry paging, tree and stats run in a separate **read worker** restricted to
  allowlisted workspace roots. Directories are not scanned implicitly; `pi-web allow <dir>` is opt-in.
- Requests outside the registered roots are refused with `forbidden: path outside registered session roots`.

**Rendering**

- Transcript markdown goes through `marked` → `DOMPurify.sanitize()` (`packages/client/src/md.ts`) with
  an explicit allowed-tag/attribute list, and untrusted content is never inserted as raw HTML.
- Payload sizes are bounded (`--max-bytes`); oversized pages and dialogs return an explicit error
  instead of truncating silently.

## Trust model, stated plainly

- **pi-web can do whatever pi can do in an allowed workspace.** A control grant is equivalent to typing
  in that project's terminal. There is no separate sandbox around model or tool execution — pi owns that,
  and pi-web deliberately does not re-implement it.
- Anything written to a session file can be rendered back into the browser. Treat session content from
  other people, cloned repositories, or model output as hostile input. It is sanitized on the way out
  and scoped to the origin, but it is still untrusted data.
- **The data directory is the credential store.** `metadata.db` holds session records, workspace
  entries, hashed tokens and hashed control grants; the plaintext API tokens exist only for their
  owner and the private key for any TLS cert you configure lives beside it. Treat the data dir the way
  you treat `~/.ssh`: owner-only permissions, backed up deliberately, never committed.
- Logs are structured and deliberately content-free: prompts, tool output and secrets are not logged.

## If you deploy this for a team

- Terminate TLS in front of pi-web with a real certificate and keep the origin on one hostname.
- The current auth model proves *that a browser holds a valid session*, not *which human* holds it:
  the shared-password + mesh design means anyone who can log in can control sessions in every
  allowlisted workspace. If you need per-user accountability, add authentication at the proxy
  (for example Tailscale/NetBird ACLs plus an OIDC gate) and keep `--host-allow` narrow. Team
  multi-user auth is planned but not implemented; do not present pi-web as a shared server otherwise.
- Keep `--host-allow` minimal and rotate API tokens (`mint-token --name`, `revoke-token --id`) when
  a machine leaves the fleet.
- Run it as a dedicated, low-privilege user with a data dir containing only the workspaces it should see.
