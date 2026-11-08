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

**Access model: no login, by design**

pi-web has no login page and no credentials of its own. The first `/api` request from a browser is
quietly given an anonymous session cookie, so opening the UI lands straight on the chats. What
protects that listener is not a password but the network and browser fences below: loopback bind by
default, a configuration-derived Host allowlist, an Origin allowlist on mutations, a double-submit
CSRF token, and no CORS for credentialed reads. Treat the bound address as the trust boundary: anyone
who can open a TCP connection to it can read and drive the sessions in your allowlisted workspaces.

**Sessions**

- Every `/api` route is served under a session: an anonymously issued browser cookie, or an
  `Authorization: Bearer` API token. Static boot assets need nothing.
- Session cookie `piweb_session` is `HttpOnly`, `SameSite=Strict`, host-only (no `Domain`), and `Secure`
  whenever the request arrives over TLS (`x-forwarded-proto` is honoured for the flag only). Cookies and
  their CSRF values are stored as SHA-256 hashes, never plaintext (`web_sessions.id`, `web_sessions.csrf_hash`).
- Anonymous sessions are pruned once untouched for 30 days (`WEB_SESSION_TTL_MS`), so cookie-less probes
  (scanners, health checks) cannot pile up rows without bound.
- Long-lived scripting tokens (`mint-token` / `revoke-token`) are stored hashed (`principals.token_hash`).
- A per-principal token bucket (600 requests/minute, non-SSE traffic) limits runaway clients.

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

**Terminal bridge (`@piwebui/pi-web-bridge`)**

- One Unix stream socket per server, `<dataDir>/bridge-<serverId>.sock`, mode `0600` inside a `0700`
  data directory. **No network listener is opened for it** — the HTTP port, Host allowlist, CSRF and CSP
  are all unchanged by the bridge.
- The secret is `<dataDir>/bridge.json` (`0600`, owner-only). It carries the shared bridge token, and
  that token is never printed in a banner, log line, CLI output or API response (`redactDescriptor`).
- Every inbound bridge is gated in order: transport caps (connection cap, per-connection buffer, frame
  size, rate) → token (constant-time compare, 5 s deadline) → `hello` identity → protocol negotiation →
  **process attestation** → trust list. A rejection names its reason (`unauthorized`, `attest_failed`,
  `duplicate_runtime`, `untrusted_runtime`, `unsupported_protocol`, `cwd_denied`, …) and those counters
  are readable at `GET /api/v1/bridge/diagnose` and by `pi-web doctor`.
- Attestation means: the `pid` a bridge claims must be a live process, that process must look like the
  Pi CLI (`pi-coding-agent` in its cmdline or an argv[0] named `pi`), and its OS-observed start time must
  match the claimed one within ±5 s. That is what stops a same-uid process from impersonating *your
  terminal pi* with a recycled pid. `--no-attest` turns it off and is documented as not recommended.
- Trust is recorded per runtime (`runtimes` table) and revocable: `pi-web revoke-runtime <id>` or
  `POST /api/v1/runtimes/:id/revoke` drops it now and refuses it until it is trusted again. Set
  `bridge.autoTrust=false` (`PIWEB_BRIDGE_AUTO_TRUST=0`) to require an explicit trust for every new runtime.
- Bridged sessions deliberately bypass the workspace allowlist: a terminal `pi` you started yourself is
  your own consent. If you want the old belt anyway, set `bridge.allowCwd` (`PIWEB_BRIDGE_ALLOW_CWD`)
  to a prefix list, and `PIWEB_BRIDGE_DISABLE=1` on a `pi` opts that terminal out entirely.

## Trust model, stated plainly

- **pi-web can do whatever pi can do in an allowed workspace.** A control grant is equivalent to typing
  in that project's terminal. There is no separate sandbox around model or tool execution — pi owns that,
  and pi-web deliberately does not re-implement it.
- **Reaching the port is the same as being signed in.** There is no login to forget or to phish, and no
  password to brute-force; but a local process on that machine, or any peer that can route to a
  non-loopback bind, gets a session and can drive those workspaces. Bind loopback unless you have put
  a real access control (mesh ACL, proxy auth) in front of it.
- Anything written to a session file can be rendered back into the browser. Treat session content from
  other people, cloned repositories, or model output as hostile input. It is sanitized on the way out
  and scoped to the origin, but it is still untrusted data.
- **Same uid is the bridge's trust boundary, and it is not an oversight.** Node exposes no
  `SO_PEERCRED` accessor (`getSocketCredentials`/`getPeerCredentials` are absent), so a Unix socket cannot
  verify the peer's uid from JavaScript. Therefore: **a process running as your uid that can read
  `~/.pi-web/bridge.json` can register a runtime and push prompts into a `pi` it can name** — exactly as a
  process running as your uid can already type into your terminal. The layers above that floor are the
  `0600` descriptor, the shared token, process attestation, the revocable runtime list, and
  `PIWEB_BRIDGE_DISABLE` if you want none of it bridged.
- **The data directory is the credential store.** `metadata.db` holds session records, workspace
  entries, hashed tokens and hashed control grants; the plaintext API tokens exist only for their
  owner and the private key for any TLS cert you configure lives beside it. Treat the data dir the way
  you treat `~/.ssh`: owner-only permissions, backed up deliberately, never committed.
- Logs are structured and deliberately content-free: prompts, tool output and secrets are not logged.

## If you deploy this for a team

- Terminate TLS in front of pi-web with a real certificate and keep the origin on one hostname.
- The auth model proves *that a browser holds a valid session*, not *which human* holds it — and since
  there is no login at all, a session costs an attacker nothing to obtain. Anyone who can reach the
  listener can control sessions in every allowlisted workspace. Put per-user accountability at the
  proxy (Tailscale/NetBird ACLs plus an OIDC gate), keep `--host-allow` narrow, and give each person
  their own host. Team multi-user auth is planned but not implemented; do not present pi-web as a shared
  server otherwise.
- Keep `--host-allow` minimal and rotate API tokens (`mint-token --name`, `revoke-token --id`) when
  a machine leaves the fleet.
- Run it as a dedicated, low-privilege user with a data dir containing only the workspaces it should see.
