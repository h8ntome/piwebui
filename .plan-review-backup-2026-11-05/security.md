# Security & Trust Model

Short version: **pi-web inherits pi's permissions and adds no sandbox.** It runs as the
same user, reads the same `~/.pi/agent`, and can drive the same sessions. Its security
goal is therefore narrow and achievable: *do not widen the blast radius, and do not create
a remote attack surface where pi had none.*

---

## What pi-web does not protect

Stated plainly because silent false comfort is worse than none. pi's own security doc says
pi "can read, change, and execute files with the permissions of the account that started
it, and it does not ask for approval before every tool call" ✓. Therefore pi-web:

| Does NOT | Consequence for the UI |
|---|---|
| Sandbox or contain pi | If pi is unsafe on this machine, pi-web is exactly as unsafe |
| Gate tool calls | No approve/deny affordance exists; the tool row appears while/after the call ran |
| Detect malicious commands | No allowlist of "dangerous" bash patterns; linting them would be theatre |
| Validate that a confirmation is meaningful | Only extension `confirm`/`select` dialogs actually block the agent ✓ — those are real |
| Protect against prompt injection | Files, comments, command output, and model text can steer pi ✓; pi-web renders the results of that steering faithfully, which is a feature and a risk |
| Replace project trust | Trust decisions still belong to pi; see [Project trust](#project-trust) |
| Provide confidentiality for session contents | Session files contain prompts, tool args, command output, and possibly secrets ✓ — pi-web must not add new copies of that data anywhere |

If stronger containment is wanted, the answer is operational and documented, not a pi-web
feature: run pi inside a container/VM/dedicated user as pi's own docs recommend ✓
([architecture.md](architecture.md#deployment-topologies) T-3).

## Threat model

| # | Actor | Capability | Realistic attack | Controls |
|---|---|---|---|---|
| T-1 | Any process on the machine (same uid) | Reads/writes everything pi can | Trivial; out of scope | Explicitly out of scope: same-uid compromise is total. Documented, not mitigated |
| T-2 | Malicious website in the user's browser | Send requests to `localhost` | CSRF/DNS-rebinding to drive pi-web (i.e. remote code execution as the user) | Loopback bind by default; token required on **every** request incl. SSE; strict `Origin`/`Host` check; no credentialed CORS; `X-Frame-Options: DENY`; CSP without `unsafe-eval` |
| T-3 | Another device on the LAN/tailnet | Reach a non-loopback bind | Unauthorized agent control if `--host` is used carelessly | Non-loopback bind requires an explicit flag + printed warning + mandatory token; `--host` documented as a deliberate act; recommend Tailscale over LAN exposure |
| T-4 | A hostile/misleading workspace | `AGENTS.md`, `.pi/*` content, tool output | Prompt injection → model runs something bad; the browser then *shows* it | Trust display ([Project trust](#project-trust)); markdown sanitization; `@path` and file links are inert text; no auto-navigation on model output |
| T-5 | A malicious pi extension | Runs in-process in agent-host with pi's permissions ✓ | Already true for the pi CLI; pi-web adds remote reachability | Capability probe lists loaded extensions in `/capabilities`; extension UI dialogs show `extensionPath`; the process boundary contains crashes, not privileges (F-4) |
| T-6 | Malformed session file / hostile `.jsonl` | Written by another tool | Parser crash, or crafted content impersonating pi records | Parser treats every entry as untrusted display data; unknown types render raw (R-9); nothing in an entry is interpreted as an instruction to pi-web; size/depth caps; no `eval`, no `Function`, no HTML injection |
| T-7 | The user, by accident | Clicks the wrong thing | Attaches a session that a terminal still holds; force-takeover | Quiet-window check, mode always visible (P-2), destructive ops (`force`, delete) confirm and explain in one sentence |
| T-8 | Supply chain | pi-web's own deps | n/a but real | Dependency budget below |

## Network exposure

### Authentication

One bearer token generated at first start, printed once to the terminal, stored server-side as a hash. Every request
must present it (`Authorization: Bearer` or the `piweb` cookie) — including `/health` and the
SSE stream, because a session-scoped read is still a session-scoped read. Details and the
CSRF/Origin rules are in the table below.


| Rule | Requirement |
|---|---|
| Default bind | `127.0.0.1` only ✓ pattern from prior art ✓; nothing listens elsewhere until `--host` is passed |
| Non-loopback | Explicit `--host` + a startup warning naming the interface and that auth is token-only |
| TLS | Not terminated by pi-web. Options documented: Tailscale Serve (recommended), or an authenticated reverse proxy |
| Auth | Single bearer token generated at startup, printed once, stored hashed server-side; revocation = restart |
| CSRF | `Origin`/`Referer` must match `Host` when present; `POST` requires the bearer header OR a double-submit `piweb_csrf` cookie paired with the `X-Piweb-CSRF` header |
| SSE auth | Token must be presented (header or cookie); query-string tokens are rejected except on the one-time seeding route, because URLs leak into logs and history |
| Cookies | `HttpOnly`, `SameSite=Lax` (Strict where feasible), `Secure` when behind HTTPS |
| Framing | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Content-Type nosniff` |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'` — inline style needed for generated tokens; **no** `unsafe-eval`, no remote origins |
| Rate limit | Global `60 rps` runaway-client guard |
| Multi-tab | Same token = same trust domain. Ownership between tabs is a lease concern, not a security one |

## Read-only file viewer and path containment

The file viewer is the only endpoint that touches the filesystem on user input, so:

1. `cwd` must match an allowlisted workspace after `realpath`.
2. `path` is joined, resolved with `realpath`, then re-checked to be **inside** that
   realpath'd workspace; any escape → `403 forbidden`.
3. Symlinks: resolved targets MUST also lie inside the workspace (default); following out
   is opt-in per workspace, never per request.
4. Denied by default regardless of containment: `.git/` internals, `.env*`,
   `*.pem`, `*.key`, `id_rsa*`, `auth.json`, `~/.pi/**` except the session files the API
   already exposes, `node_modules` (perf), and anything over `2 MB` text / `10 MB` binary
   (return `{binary:true, truncated:true}` instead of content ✓ style).
5. Responses never include file *content* in logs or error messages.
6. No write, create, delete, rename, chmod, or upload endpoints exist. Not disabled —
   absent, so a bug cannot enable them.
7. Nothing read by the file viewer is ever sent to pi automatically. The user pastes or
   `@references` it; pi then reads it under pi's own rules ✓. This is what keeps the
   exception in [vision_and_scope.md](vision_and_scope.md#the-contract) small.

## Rendering untrusted content

Model and tool output is untrusted text ✓:

- Markdown rendered with **DOMPurify** after a sanitizing parse; raw HTML in model output
  is dropped, not sanitized-and-kept (safer default, and pi's TUI renders no HTML either).
- Link `href` allowlist: `http(s):`, `mailto:`, and relative file paths shown as inert
  text. `javascript:` and friends removed. Links get `rel="noopener noreferrer"` and
  `target="_blank"` — never same-tab navigation from model content.
- No `srcdoc`, no `<iframe>`, no `<object>`, no remote `<img>` in v1 (image attachments are
  local `data:` from the user's own paste ✓).
- ANSI escapes in tool output are **stripped for display** and shown raw in the expanded
  view; they never reach the DOM as markup.
- Long/unterminated unicode and control characters neutralized for display; the raw bytes
  stay available via `/sessions/:id/raw`.

## Project trust

pi's project trust gates loading of project `.pi/settings.json`, `.pi/extensions`,
`.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/mcp.json`, and system prompt files ✓ —
and **print, JSON, and RPC modes cannot show the built-in trust prompt** ✓: with
`defaultProjectTrust` of `"ask"`/`"never"` the protected resources are skipped, with
`"always"` they load ✓.

pi-web implications and design:

| Concern | Design |
|---|---|
| Which sessions are "trusted" | pi-web shows pi's stored decision from `trust.json` ✓ per workspace (`GET /workspaces/:path/validate`) — display only |
| Changing a trust decision | Not offered in v1. Directing the user to run pi interactively (`/trust`) is correct; writing `trust.json` ourselves would let the browser grant itself code execution rights |
| `SdkDriver` non-interactive behaviour | Same rule applies ✓; the server passes an explicit policy from config (`trust: "inherit" \| "approve" \| "deny"`), default `"inherit"`, and the UI shows the effective answer next to the session |
| User-visible effect | Attaching in a workspace with unloaded project extensions may show fewer commands than the CLI does (`get_commands` ✓ reflects what loaded). The API surfaces the trust state so the UI can say why |

## Extension UI dialogs

Extension `select`/`confirm`/`input`/`editor` requests block the agent until answered ✓
with a `timeout` auto-resolving to a default server-side ✓. pi-web renders them verbatim,
shows the requesting `extensionPath`, and states the timeout. It adds no policy of its own:
whatever an extension asks to confirm is that extension's semantics, and the TUI would have
shown the same prompt. Notification-style methods are non-modal by contract ✓ and stay
non-modal here.

## Logging and privacy

| Rule | Detail |
|---|---|
| No transcript logging | Server logs never contain prompt text, assistant text, tool args, or tool output. Correlation ids only |
| Redaction | Any debug dump redacts `Authorization`, token material, and provider keys; pi's own bug reports already exclude credential values ✓ — we match that bar |
| No telemetry | pi-web sends nothing outbound. No update checks by default (a manual `pi-web --check` MAY exist; prior art ships an update-check endpoint ✓ — we deliberately skip it) |
| Local storage | `piweb.db`: leases, prefs, workspace allowlist, idempotency cache. `localStorage`: theme, rail state, drafts. **No** conversation copies — D-10. File is `0600` |
| Session contents stay local | pi's own `/share` (gist/radius ✓) remains a terminal action; pi-web offers `/sessions/:id/export` to a **local** file only, never an upload |
| Log rotation | `--log-file` optional, `5 MB` × 3, off unless requested |

## Dependency budget

Minimalism as a security property. Proposed ceilings, enforced in CI:

| Layer | Allowance |
|---|---|
| Server | Fastify, TypeBox, better-sqlite3, `dompurify` (server side not needed), `marked` (client), `picomatch` (deny globs) — target ≤ 25 production deps |
| Client | React, react-dom, Zustand, marked, DOMPurify, shiki (lazy) — target ≤ 20 |
| Banned | Any "chat UI kit", any analytics/error-reporting SDK, any crypto lib we don't need, jQuery-class utils, anything pulling a headless browser |
| Pi | Declared as a pinned peer/dependency so the version under test is explicit; `proper-lockfile` arrives transitively ✓ and is not re-added unless we take the cross-machine lock option |

## Pre-launch checklist

- [ ] `curl` from another host cannot reach the port on default config
- [ ] Request with foreign `Origin` → `403`; request without token → `401` (including `/health` when non-loopback)
- [ ] DNS-rebinding probe (attacker domain resolving to `127.0.0.1`) rejected by Host check
- [ ] Path traversal suite: `..`, encoded, absolute, symlink-out, case variants, unicode normalize → all `403`
- [ ] XSS suite: crafted tool output with `<img onerror>`, `<script>`, `javascript:` href, ANSI-escape spoofing, giant single line → inert
- [ ] Model output cannot trigger navigation, focus theft, or clipboard writes
- [ ] `/sessions/:id/raw` cannot be used to read outside the session dir
- [ ] Logs grepped for prompt text and tokens (automated test)
- [ ] CSP verified with no console violations; `unsafe-eval` absent
- [ ] Documented: "pi-web grants whatever pi already has — no sandbox here" in the root README, not buried
