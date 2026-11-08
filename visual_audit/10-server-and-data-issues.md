# 10 — Server/API behaviours the UI inherits

These were found from the UI, so they are listed here even when the fix lives server-side.

### SRV‑01 · High · `pi-web allow <dir>` does nothing while the server runs
**Evidence:** with the audit server live, `pi-web allow /tmp/audit/edge …` printed
`workspace allowed: …` but `GET /api/v1/workspaces` returned `{"workspaces":[]}` and the UI showed
nothing; a restart was required. `loadWorkspaces()` is called exactly once at boot
(`main.ts:235`) and nothing reloads the table. Ironically *new session files* are picked up live
(30 → 31 without restart), so the file watcher works and only the allowlist is static.
**Impact:** the documented quick start (`pi-web` then `pi-web allow …`) leaves a first-time user with
an empty UI and no error.
**Fix:** reload `workspaces` from SQLite on every `GET /workspaces`/`/sessions` (cheap) or have the
CLI notify the running server; at minimum print "restart pi-web to pick up the allowlist".
**Evidence:** audit log (curl transcripts in `10` notes), `01-desktop-hero.png`

### SRV‑02 · Critical (shared with `TRN‑01`) · Pagination exists server-side but is unused
`GET /sessions?limit=200` returns `nextCursor` (and correctly rejects `limit=500` with
`invalid_request: $: must be <= 200`), and `GET /sessions/:key/entries` pages at 200 with a
`nextCursor`. The client hard-codes `limit=200` for the session list and reads a 300-entry snapshot
window for the transcript, never following cursors and never setting `hasOlder`.
**Impact:** with >200 sessions the extra ones are silently absent; with >300 entries the oldest part
of a conversation is unreachable (`TRN‑01`).
**Fix:** client cursor loops (or infinite scroll) for both lists; server: return an explicit
`olderAvailable: true` in the SSE snapshot so the client can render "load older".

### SRV‑03 · Medium · `meta.limits.entriesPageMax` (1000) disagrees with actual paging (200/300)
The About tab prints the advertised 1000 (`SET‑06`). Either honour 1000 or report the effective page
size.

### SRV‑04 · Medium · Malformed session lines are dropped without telling the user
`GET /sessions/:key/entries` returns `diagnostics: [{ message: "invalid JSON line: Expected
property name or '}' …", byteOffset: 27394 }]`, but the client ignores `diagnostics` entirely and
`Transcript.InvalidRow` (the "Unreadable entry" card, wired to `entry.invalid`) is unreachable in
practice because invalid records never become entries.
**Impact:** a partially corrupt session looks complete; the user has no idea content is missing.
**Fix:** render a dismissible banner ("1 line could not be read at byte 27 394 — the raw log is
unchanged") from `diagnostics`, and keep `InvalidRow` for entries that exist but fail projection.

### SRV‑05 · Medium · Server death is invisible to an open tab
**Repro:** kill the pi-web process while the UI is open.
**Actual:** after 8+ s nothing changes: `ready` stays `true`, no toast, no "stream disconnected"
pill (the indicator only appears when `view.sse === "closed"`, but `EventSource` keeps retrying so
`onerror` reports `connecting`, never `closed`). The transcript silently freezes — the worst failure
mode for a live-monitoring tool. Reloading then shows the browser's own error page (HTML gone) or the
app's BootScreen if only the API is down.
**Fix:** track failed reconnects/time-since-last-event (the server already defines
`sseHeartbeatMs: 15000`, `sseClientSilenceMs: 45000`) and promote to `closed` in the client, plus a
retry counter in `boot()`.

### SRV‑06 · Medium · Session `state` is reported as `unavailable` for all file-mirror sessions
Every history/mirror session listed `state:"unavailable"` (also rendered verbatim in the Session
panel, `PNL‑04`). A neutral term ("idle", "not running", or just omit the row) would avoid implying a
fault, and the `history`→`mirror` label change after the first refresh (`GEN‑05`) makes the same
session appear under two names.

### SRV‑07 · Low · `501` responses for models/commands on read-only sessions
`GET /sessions/:key/models` and `/commands` return 501 for mirror sessions. That is defensible, but
combined with `CTL‑02` the client cannot distinguish "not available here" from "not loaded yet", so
the model menu shows the wrong message. Prefer `200 {models: []}` + a capability flag, or map the
error code into the menu copy.

### SRV‑08 · Low · `Failed to fetch` shown verbatim in the boot screen
The BootScreen hint copy is good ("Cannot reach the pi-web server. Start it with `pi-web` and this
page retries by itself.") but the error line under it prints the raw `TypeError: Failed to fetch`.
Map fetch failures to "No response from the server at this address" and keep the raw text behind a
details disclosure.
**Evidence:** `56-boot-error.png`

### SRV‑09 · Info (no action) · Things that behaved correctly under stress
Worth recording, since they were checked and passed: path traversal/denylist (`files.ts` realpath
per component, `symlink escapes workspace`), `too_large` (>2 MB) and `binary` previews, hidden-file
filtering in the picker, CSRF + cookie bootstrapping without a login page, `limit` validation,
idempotency-key reuse for commands, control-grant renewal across ~50 min of commands (no
`stale_control` failures), CSP/security headers on every response, and deterministic SSE snapshots.
