# Security and trust

Pi runs with its account's permissions. pi-web adds authenticated remote control, not a
sandbox. A managed child and a terminal bridge share the user's privilege boundary.
Tool rows are observations; actual extension dialogs retain their real semantics.

## Network and authentication

- Default 127.0.0.1:4319; explicit configured host/origin allowlists, not comparison to an
  untrusted Host header. Reject DNS-rebinding Hosts even when Origin matches that Host.
- NetBird routing alone does not provide HTTP authentication or browser-trusted HTTPS.
  Verify the existing deployment; proxy loopback through a trusted HTTPS endpoint reachable
  only by intended NetBird peers. Do not expose 0.0.0.0 or publish public ingress by default.
- Generate a high-entropy bootstrap secret/one-use code; terminal display only, no access-log
  query leakage. Dedicated short-lived exchange issues HttpOnly SameSite=Strict cookie
  where usable, Secure on HTTPS, narrow path and no Domain. Referrer-Policy:no-referrer.
  Static boot assets contain no session data; API/SSE/meta/health all require auth.
  *(Superseded 2026-11-07: the login page and the bootstrap code were deleted. The pipeline now issues an
  anonymous HttpOnly SameSite=Strict session cookie on the first API call, and the bound address is the
  trust boundary. The cookie/CSRF/Origin rules below are unchanged.)*
- Cookie-authenticated POST/PATCH/PUT/DELETE require explicit CSRF token/header and matching
  trusted Origin. Bearer automation clients need a validated host and reject foreign Origin
  when present. Never weaken auth for SSH forwarding or loopback.
- Native EventSource uses cookies; reusable query tokens are forbidden. Reverse-proxy identity
  headers are trusted only from an explicitly trusted proxy that strips incoming copies.
- CSP without unsafe-eval: self scripts/connect/fonts, no frame/object, no remote image
  fetches from transcript, frame-ancestors none; nosniff. Boot theme uses a same-origin
  blocking external script or CSP nonce/hash, not an unallowed inline script.
- Apply connection/request/body limits without throttling SSE heartbeats as ordinary REST.

## Local bridge and processes

Bridge sockets/registry directories 0700, records 0600; random per-runtime token;
validate socket ownership, peer/process identity where platform permits, registry
binding, start identity and current session generation. Never trust a PID alone or accept
an arbitrary socket path from the browser. No bridge HTTP listener. Remove stale artifacts
only when generation ownership is proven; never unlink another bridge's active socket.

One server lock across participating data/session roots. Managed hosts authenticate IPC,
terminate or enter documented fail-closed state on parent death, and are not automatically
respawned into an ambiguous active file. Browser disconnect is distinct from parent death.
No auto-modification of installed Pi, existing Paseo bridges, VPN or active sessions.

## File/session authorization

Allowlist workspaces and session roots explicitly. Every session list/read/raw/SSE/command
revalidates authorization; filename/path routing alone is insufficient. Use opaque resource
keys, validate header cwd and canonical file location, deny symlink escape. Reads must not
follow arbitrary session paths outside registered roots. Removing a workspace immediately
blocks new remote access/commands and offers explicit choices for an ongoing run; it never
silently aborts Pi or widens file access.

File viewer realpath containment uses path-component checks, not string prefixes. Protect
against symlink-swap races using appropriate descriptor-based reads/rechecks/no-follow
operations, with a documented same-user attack limitation. Deny `.env*`, private keys,
auth files, `.git` internals and Pi credentials regardless of normal containment. No
opt-in escape symlinks in v1. Cap text to 2 MiB; binary metadata only. Bound file/listing
sizes, recursion, JSON nesting, image decoded bytes and raw/range requests. Never read
an arbitrary `fullOutputPath` just because a tool-result entry names it.

The allowlist governs pi-web's direct reads/session selection, not a Pi tool sandbox.
Pi may read outside cwd with its own permissions. Explain that distinction.

## Rendering and data minimization

All session/model/tool/extension content is untrusted. Disable raw HTML before Markdown
sanitization; DOMPurify final output; safe links with explicit user clicks, noopener and
noreferrer. No script URLs, iframes, srcdoc, remote images, active SVG attachments, focus
or clipboard side effects from output. Validated raster user images only, <=4 and within
8 MiB **encoded JSON** request ceiling; enforce decoded/pixel limits too.

Do not alter raw stored bytes. Neutralize control/ANSI spoofing for display, inspect raw
through bounded text download. Unknown content cannot register commands or become a path
capability. Logs contain IDs/status/correlation only, no prompts/tool args/output/secrets.
Pi/extension stderr can contain those values: do not store/expose raw stderr debug dumps.
Keep exit/sanitized diagnostic metadata only; debug endpoint is not an exception to privacy.

Private DB: allowlists, prefs, grants, operation hashes/receipts. Do not store response bodies
that include transcript content as an idempotency cache. No transcript copy, telemetry,
remote fonts, update checks or upload/share. Draft persistence is opt-in per-browser with
clear/delete controls and reset on logout; default memory-only to reduce secret remnants.

## Trust and dialogs

Preserve Pi's actual trust state and configuration. A live bridge inherits the terminal's
already-established trust; a read-only worker loads no project code. Managed creation
uses an explicit tested noninteractive trust policy and shows skipped project resources.
Do not write trust.json or offer hidden --approve. Never weaken extensions/model/tools
just to make a demo pass.

Bind managed ExtensionUIContext before execution; unanswered dialogs remain pending,
reappear on reconnect and use Pi/extension cancellation/timeout semantics. No invented
approval or default yes. Terminal prompt notification is not proof of remote answering;
its P0 gate is mandatory for any claimed phone-only terminal workflow.

## Required release checks

Auth on every data endpoint; Host/DNS-rebinding; CSRF across mutation methods; forged
proxy headers; stale control/operation replay; socket spoof/stale PID; path and symlink
races; cross-workspace leaks; raw/range downloads; XSS/ANSI/giant records; log/DB secret
absence; restrictive CSP; same-origin cookie/EventSource over actual phone HTTPS;
workspace removal during work; no installed Pi/Paseo or session writes from GETs.
