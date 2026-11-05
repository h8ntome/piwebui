# Implementation Plan

One developer (Hadi + pi), evenings-and-weekends pace unless noted. Estimates are
*focused days*, not calendar days; ranges are deliberately wide because the pi-upgrade
surface (R-06) is the main unknown. Sequencing principle: **a walking skeleton before any
feature** — the end of P0 is already a real pi turn rendered in a browser.

---

## Phase table

| Phase | Theme | Scope | Days | Exit gate |
|---|---|---|---|---|
| P0 | Walking skeleton | `npx pi-web` serves a page; one existing session renders read-only from disk | 3–5 | first paint of a real CLI session, correct leaf, `health` + `meta` live |
| P1 | Read-only parity | session list, cold-open projection, `/context`, `/stats`, entry-type matrix, raw view | 4–7 | S-1 and S-5 pass; every entry type renders or shows as unknown |
| P2 | Mirror | live tail, SSE, cursor resume, mode chips, reconnect | 4–6 | S-4, S-6, C-1…C-8 pass |
| P3 | Attach & control | agent-host, `SdkDriver`, lease, prompt/steer/followUp/abort, model/thinking, composer states | 6–10 | S-2, S-9, S-10 pass; a full prompt round-trip with no divergence |
| P4 | Transcript polish & files | tool rendering table, diffs (read-only), read-only file viewer, find, virtualization, palette generation | 5–8 | S-12, F-17, path-containment suite green, contrast audit green |
| P5 | Branching & extensions | tree view, fork/clone/branch, `context_edit` badges, extension UI dialogs, queue chips | 5–8 | S-7, S-8, extension `confirm` round-trip, branch switch mirrored |
| P6 | Hardening & packaging | security checklist, reliability matrix tests, soak, `launchd`/`systemd` examples, docs, CLI flags | 4–6 | every pre-launch box in [security.md](security.md#pre-launch-checklist) ticked; 24 h soak |
| P7 | v1 release | README, demo script, pinned-compat statement, `1.0.0` publish, capability lock | 2–3 | the 90-second demo works on a clean machine with no pi-web config |
| **Total** | | | **33–53** | |

Optional/after v1 (backlog at the bottom). P0–P4 = the MVP line in
[vision_and_scope.md](vision_and_scope.md#mvp-cut-line); P3 is the first phase that lets
pi-web write, so it carries the highest risk and gets its own gate.

## Phase detail

### P0 — Walking skeleton

Purpose: prove the four-layer boundary and the pi integration on real data before any
pixel-perfect work.

Deliverables
- Repo scaffold (npm workspaces: `shared`, `server`, `client`), TypeScript strict, ESLint
  boundary rule (only `drivers/` imports pi), CI (typecheck, lint, unit, e2e-smoke).
- `packages/server/src/drivers/pi-probe.ts`: prints pi version + capability list
  ([appendix_pi_facts.md](appendix_pi_facts.md#capability-probe)) and fails loudly on an
  untested version.
- Fastify server: `/health`, `/meta`, `/sessions`, `/sessions/:id/entries`, static SPA.
- `SdkDriver.openSession()` + `getEntries()`/`getTree()` via `SessionManager.open/list` ✓.
- React app: rail (flat list from `/sessions`), transcript (naive full render),
  `tokens.css` generated from pi's `dark.json` ✓, dark only.
- One test fixture dir with a synthetic session exercising every entry type.

Out of scope: SSE, leases, composer, light mode.

Exit demo: `node packages/server/src/index.ts` → browser → pick the session created in a
terminal this morning → transcript matches pi's own view.

### P1 — Read-only parity

Deliverables
- `GET /sessions/:id/context` computed inside agent-host with pi's own
  `buildSessionContext`/`buildSessionProjection` ✓ so "what the model will see" is not a
  reimplementation (retires risk R-06 for the read path).
- `GET /sessions/:id/stats` (`get_session_stats` shape ✓) + context meter in the composer
  row (disabled state).
- Full entry-type matrix from [session_management.md](session_management.md#entry-type-rendering-matrix)
  incl. compaction divider, `usage` invisibility, `custom`/`custom_message`, unknown-raw.
- Session list: grouping by cwd from the path encoding ✓, `name` ✓, search via
  `allMessagesText` ✓, sort, `limit/cursor`; `onProgress` streaming for big dirs.
- `/sessions/:id/raw` with byte ranges; export HTML passthrough ✓.
- Playwright: fixtures + a real-pi-generated session; snapshot tests per entry type.

Exit: S-1, S-5 green; a reviewer can compare browser vs `pi --continue` on the same file
and find no differences in what the model would receive.

### P2 — Mirror

Deliverables
- `mirror/` tailer (LF-only framing, partial-line hold, shrink detect, burst cap ✓ rules in
  [event_rendering.md](event_rendering.md#mirror-tail-parsing)).
- SSE channel with `id:` = entry id, heartbeat, `Last-Event-ID` resume via
  `get_entries(since)` ✓, `stream_end`, coalescing.
- Client `EventSource` manager: backoff+jitter, dead-stream detection, resync handling,
  `snapshot` rebuild, `source:"mirror"` labelling.
- Mode model + mode chip + read-only composer states (`history`, `mirror`).
- Divergence detector groundwork shared by mirror and attach (external-change watcher API).

Exit: S-4, S-6 and C-1…C-8 pass; a `pi` session driven in a terminal renders live in a
browser tab across a refresh.

### P3 — Attach and control

Deliverables
- `agent-host` process: IPC envelope, ping/pong, restart policy, per-session supervisor ✓
  ([architecture.md](architecture.md#internal-contract-between-api-server-and-agent-host)).
- Lease table + API (`GET/POST/PATCH /sessions/:id/lease`), fencing tokens, TTL renewer,
  takeover rules, quiet-window check, `409 lease_conflict`.
- Commands: `prompt` (with `streamingBehavior` handling ✓), `steer`, `follow_up`,
  `clear_queue` (restore text ✓), `abort`, `set_model`, `set_thinking_level`,
  `set_auto_compaction`, `set_auto_retry`, `abort_retry`, queue modes ✓. Idempotency store.
- Live event normalization N-1…N-7 including driver-agnostic delta stripping.
- Composer full state machine incl. forced steer/follow-up choice while streaming ✓;
  slash-command autocomplete from `get_commands` ✓; image paste → `ImageContent` ✓.
- Context meter live; usage from stats only (R-7).
- `RpcProcessDriver` **interface kept complete and compiling** with a smoke test, so the
  escape hatch stays real rather than aspirational.

Exit: S-2, S-9, S-10 pass; F-06/F-07/F-21 tests pass; a browser session handoff to
`pi --continue` loses nothing. **Hard gate:** no divergence may be silently ignored.

### P4 — Transcript polish and files

Deliverables
- Virtualized transcript (threshold `150`, height cache), jump-to-latest, in-page find,
  deep links `?at=<entryId>` ✓.
- Per-tool renderers + diff renderer (`edit` ✓) with pi's diff colours ✓.
- Read-only file viewer + path-containment suite; git status/diff read-only.
- Palette generation for light ✓ + `auto`; contrast audit script in CI.
- Perf budget harness (frame sampler, DOM-node assertion, 10 000-delta burst test).

Exit: S-12, F-17 pass; budgets in
[event_rendering.md](event_rendering.md#performance-budgets) measured green on a
reference laptop; security path/XSS suites green.

### P5 — Branching and extensions

Deliverables
- Tree view + branch/fork/clone/new/switch wiring ✓ with `cancelled` handling (extension
  vetoes ✓).
- `context_edit` badges ✓, `label` bookmarks + filter ✓, `branch_summary` styling ✓.
- Extension UI dialogs + notification stack ✓ incl. timeout display ✓ and
  `/extension-ui-response`.
- Multiplexed events endpoint (optional), `/debug/*` endpoints, optional local metrics.

Exit: S-3, S-7, S-8 pass with a real extension that uses `ctx.ui.confirm`.

### P6 — Hardening and packaging

Deliverables
- Failure-matrix test pass: every row F-01…F-24 automated or with a recorded manual
  procedure.
- 24 h soak; leak check; SSE-through-proxy test; Windows pass (`proper-lockfile` quirks ✓,
  path encodings, `trash` fallback ✓).
- CLI surface: `pi-web`, `--port`, `--host`, `--session-dir` override ✓, `--workspace`,
  `--read-only`, `--driver sdk|rpc`, `--print-token`, `--check`.
- Ops examples: `launchd` plist, `systemd` unit, Tailscale recipe, Dockerfile
  (T-3) with the honest caveat.
- Full README + this plan updated to match reality; docs site optional.

Exit: security pre-launch checklist complete; all `Q-0n` resolved.

### P7 — Release

Version pin matrix (`pi-web` × tested `pi`), capability snapshot committed, changelog,
`npx pi-web@latest` smoke test on a clean machine and on a tailnet phone, 90-second demo
recorded, `1.0.0`.

---

## Testing strategy

### Layers

| Layer | Tooling | Covers |
|---|---|---|
| Contract snapshot | Vitest, reads installed pi `dist` + docs | every ✓ claim in [appendix_pi_facts.md](appendix_pi_facts.md) — entry types, event names, RPC command list, palette values. A pi upgrade fails this first, before anything user-facing breaks |
| Unit (pure) | Vitest | tailer framing, projection reimplementation vs pi's exported functions ✓, palette conversion, lease math, reducer rules RR-1…RR-10, containment logic |
| Integration | Vitest + real fs in a temp `HOME` | `SessionManager` interop, create/open/list/fork ✓, SSE resume with a real file, idempotency replay |
| Real-pi integration | Vitest, spawns actual `pi` (SDK + `--mode rpc`) | driver equivalence: same session through both drivers yields byte-identical wire events after normalization (N-1) |
| e2e | Playwright | the 12 continuity scenarios S-1…S-12, reconnect matrix C-1…C-12, keyboard map, a11y snapshot |
| Visual | Playwright screenshots vs golden | entry-type matrix, both palettes, tool states, diff, tree, mobile widths |
| Security | Vitest + a request script | traversal, Origin/CSRF, CSP, XSS corpus, log-redaction grep |
| Soak/perf | Custom script + CI nightly | 24 h streaming, RSS growth, budgets, 5 000-entry session |

### Test data

A generated corpus under `fixtures/sessions/` produced by a script that drives real pi:
plain branch, multi-branch with `branch_summary`, pre/post compaction (incl. retain-none ✓),
`context_edit` (replace, omit, on tool result ✓), `usage` entries with odd `kind` ✓,
`custom` virtual-model state ✓, `custom_message` display on/off ✓, labels, model changes,
a truncated bash result (`truncated` + `fullOutputPath` ✓), a redacted thinking block ✓,
an unknown entry type (hand-written), a v1 session needing migration ✓, a 5 000-entry
long session, a 0-byte file, a file with a corrupt last line (torn write), and a v3 file
with multiple roots ✓.

Rules: every fixture has a `.expect.json` describing the projected context, so the
"browser agrees with pi" claim is data-driven rather than eyeballed.

### The acceptance suite (named)

| Group | IDs |
|---|---|
| Continuity | S-1…S-12 ([session_management.md](session_management.md#continuity-test-scenarios)) |
| Reconnect | C-1…C-12 ([reliability.md](reliability.md#reconnect-matrix)) |
| Failures | F-01…F-24 ([reliability.md](reliability.md#failure-matrix)) |
| API conformance | the checklist in [api_spec.md](api_spec.md#conformance-checklist) |
| UI states | every row of [ui_design.md](ui_design.md#everything-states) has a story |
| "Looks like pi" | the checklist in [visual_design.md](visual_design.md#looks-like-pi-checklist) is a review ritual each release |

### Definition of done, per PR

Typecheck, lint (incl. import-boundary), unit + integration green, no new
console errors in e2e, perf budget unregressed, and any changed ✓ claim re-verified.

## Repo engineering conventions

| Topic | Rule |
|---|---|
| Runtime | Node `>=22.19.0` (pi's own floor ✓), CI on latest LTS + current |
| Package manager | npm workspaces (installed npm 11 ✓); pnpm 9 available if hoisting pain appears; Bun not required |
| TypeScript | strict + `noUncheckedIndexedAccess`; wire types generated once in `shared` |
| Format/lint | Prettier + ESLint; `no-restricted-imports` guards; `no-restricted-syntax` banning hex colours in client |
| Commits | Conventional commits; changelog generated |
| CI | typecheck · lint · unit · integration · contract-snapshot · e2e (chromium) · visual (main only) · security suite · perf nightly |
| Release | `npm publish` with an `npx pi-web` cold-start smoke test in CI; `--dry` local install check |
| Versioning | SemVer on pi-web; the tested pi version recorded per release; breaking pi changes get a compatibility note |

## Backlog after v1

Multi-pane for two sessions · session diff-review workflow · PWA shell + Web Push for
"run finished" · workspace-scoped read-only file search · cross-machine read-only
aggregate (multi-server federation) · `RpcProcessDriver` per-workspace sharding for
real isolation · theme sync from the user's active custom pi theme ✓ · accessibility
audit with a screen reader by a real user · translation of UI copy · Windows-specific
polish · an optional CLI (`pi-web sessions --json`) reusing the server internals ·
contributing a session-file advisory lock upstream to pi so the lease becomes redundant
(the cleanest long-term fix to F-2 / R-01, and worth a pi feature request).
