# Risks & Open Questions

---

## Risk register

Scored `L×I` (likelihood × impact, 1–3 / 1–5). Anything ≥ 9 gets an explicit mitigation
owned by a phase.

| ID | Risk | L | I | Score | Mitigation | Phase |
|---|---|---|---|---|---|---|
| R-01 | **Double-writer divergence** between terminal pi and pi-web silently drops turns. pi does not lock session files ✓ | 3 | 4 | 12 | Lease + fencing + quiet window + divergence detection + never auto-merge; D-05 (never write the file ourselves); mirror mode as the safe default answer ([session_management.md](session_management.md#the-single-writer-rule)) | P3 |
| R-02 | **pi upgrade breaks** internal assumptions (entry types, event names, RPC commands, `dist` layout). Prior art churns with pi versions ✓ | 3 | 4 | 12 | Contract-snapshot test asserting every ✓ claim; capability probe gating features, not versions; unknown types render raw (R-9); read-only fallback on unverified pi (F-14) | P0, P6 |
| R-03 | **Read-path reimplementation drifts** from pi's own context rules (compaction/`context_edit`/branch selection ✓), so the browser shows a different "context" than the model gets | 2 | 5 | 10 | Compute `/context` inside agent-host using pi's exported `buildSessionContext`/`buildSessionProjection` ✓ rather than reimplementing in TS or the browser; fixture corpus with `.expect.json` | P1 |
| R-04 | **Extension crash takes down the agent** (extensions run in-process ✓) | 2 | 3 | 6 | `agent-host` is a separate process; restart policy + leases released + banner (F-04); `RpcProcessDriver` remains if isolation must be stronger (D-03) | P3 |
| R-05 | **Token streaming jank** (flicker, reflow, dropped delta visible) | 2 | 3 | 6 | Delta coalescing budget, block replacement on `text_end`/`message_end` ✓, no per-token animation, one paint/frame; perf harness with a 10 000-delta burst | P4 |
| R-06 | **Browser becomes an attack surface** for a tool that was terminal-only (CSRF, DNS rebinding, path traversal, XSS via tool output) | 2 | 5 | 10 | Loopback default, token on every request incl. SSE, Origin/Host checks, no CORS, CSP without `unsafe-eval`, DOMPurify + no raw HTML, realpath containment, security suite in CI ([security.md](security.md)) | P4, P6 |
| R-07 | **False sense of control**: users read the UI as an approval gate | 2 | 4 | 8 | P-3 and N-2: no fake approvals, explicit copy, only real extension dialogs block ✓; README states it up front | P3, P7 |
| R-08 | **Long sessions blow up memory / DOM** ✓ | 2 | 3 | 6 | Virtualization, height cache, slice-render, cursor reads instead of full file reads, F-17 handling | P4 |
| R-09 | **Session dir scale** makes listing slow (`list()` reads files ✓) | 2 | 2 | 4 | Progressive list with `onProgress` ✓, TTL cache, `limit/cursor`, list lazily per workspace | P1 |
| R-10 | **Scope creep toward a chat product** (bubbles, analytics dashboards, editor, terminal pane) | 3 | 3 | 9 | Written anti-features ([ui_design.md](ui_design.md#anti-features)), non-goal table with reasons, and the acceptance ritual "does this keep pi as the only executor?" | ongoing |
| R-11 | **SSE broken by proxy/buffering** on tailnet setups | 2 | 2 | 4 | Heartbeat comments, `no-transform`, documented `X-Accel-Buffering: no`, F-19 test, WebSocket retained as a documented alternative (not implemented) | P6 |
| R-12 | **Two pi-web servers** running simultaneously against one session dir | 2 | 3 | 6 | Single-instance `proper-lockfile` guard ✓ at startup (F-20) | P6 |
| R-13 | **Name collision** with the existing popular `agegr/pi-web` ✓ confuses discovery and invites feature-parity pressure | 3 | 2 | 6 | See Q-01; decide the name deliberately, differentiate in README (no terminal pane, no editor, strict control-layer contract) | Q-01 |
| R-14 | **Lease complexity outweighs value** for a single user who mostly wants to *watch* | 2 | 3 | 6 | Mirror mode is the v1 hero (safe, zero risk). If attach usage turns out rare, leases can shrink to a single-tab guard; the design keeps that door open | P3 |
| R-15 | **Prompt injection content rendered as trusted UI** (tool output that looks like system messages) | 2 | 3 | 6 | Untrusted-content rendering rules, honest entry-type labelling, never interpret entry content as instruction ([security.md](security.md#rendering-untrusted-content)) | P4 |
| R-16 | **Windows-specific breakage** (lockfile EPERM races ✓, path encodings, `trash` absence ✓) | 2 | 2 | 4 | Explicit non-goal for v1 (N-12) but no macOS-only assumptions in core logic; P6 pass documents known gaps | P6 |
| R-17 | **The plan outruns one maintainer** and stalls at P4 | 2 | 4 | 8 | Each phase independently useful and shippable; P0–P2 alone is a genuinely good session viewer, so partial delivery is not failure | P0–P4 |
| R-18 | **pi-web's own metadata** (drafts, prefs) leaks into what looks like session state | 1 | 3 | 3 | Hard separation in the state table; drafts localStorage-only | P3 |

Structural mitigation worth restating: if pi ever adds an advisory lock on session files,
most of R-01 disappears and pi-web's lease becomes a thin UI concern. That is the single
most valuable upstream change pi-web could benefit from (backlog item in
[implementation_plan.md](implementation_plan.md#backlog-after-v1)).

## Open questions

Nine decisions needed from Hadi. Each has a recommendation and a default so work can
proceed while unanswered; defaults are already assumed throughout this plan.

### Q-01 — Product name

`pi-web` is already used by at least three projects, one with substantial adoption ✓
([prior_art.md](prior_art.md)). A prior session also referred to this as "Pi (Fly)".

| Option | For | Against |
|---|---|---|
| Keep `pi-web` | exact discoverability, honest description, matches the folder | collides with the popular repo; npm name likely needs a scope |
| `pi-web-window` / `pi-mirror` / `pi-cockpit` | distinct, and "mirror/observe" is literally our differentiator | weaker search match |
| `pi-fly` | continuity with the earlier framing; ownable | inside pi's own repo there is already a `pi-agent`/`pi` naming space; slightly cute |

**Recommendation:** ship as **`pi-mirror`** internally with the tagline "a web view and
control surface for pi sessions", or keep `pi-web` if the priority is discoverability over
differentiation. Default assumed: **`pi-web`** (package `@hadi/pi-web` to avoid the npm
squatter). **Needs your call — it affects the README framing throughout.**

### Q-02 — Workspace policy

How does a directory become usable in pi-web?

| Option | Notes |
|---|---|
| A. Explicit allowlist (recommended) | Nothing usable until `pi-web --workspace <path>` or the settings UI adds it. Safest; matches [security.md](security.md#read-only-file-viewer-and-path-containment) |
| B. Auto-derive from `~/.pi/agent/sessions/` dirs | Zero setup (every place you have ever run pi is instantly browsable) but a browser can immediately read those workspaces' files via the viewer |
| C. Allowlist for writing, auto-derive for reading | Nice ergonomics; two policies to explain |

**Recommendation:** A for v1, revisit C. Default assumed: **A**, started from the existing
session dirs as a *suggested* list that the user confirms once.

### Q-03 — Port and network exposure

Default `127.0.0.1:4319`, token-authenticated, tailnet via Tailscale Serve for phone
access. Alternative: bind `0.0.0.0` + token (rejected: LAN exposure for no benefit).

**Recommendation:** as above. Confirm the port number if it clashes with anything you run.
Default assumed: **`127.0.0.1:4319`, tailnet for remote**.

### Q-04 — Frontend stack

React + Vite + Tailwind, no component library (D-08). Alternatives considered: Preact
(smaller, ecosystem friction), Svelte (nicest for a small hand-written UI, single-framework
lock-in), Solid, vanilla web components (fastest cold start, highest cost per feature).

**Recommendation:** React 19 (largest model/tooling familiarity, easiest for a future
contributor). Default assumed: **React**. Flip to Svelte only if you expect to maintain
this long-term alone and prefer its ergonomics — that decision is cheap at P0 and
expensive at P4, so it must be made now.

### Q-05 — Concurrent attached sessions

`maxAttached = 1` in v1 vs `4`. Prior art supports several at once ✓, at the cost of
multi-writer testing surface.

**Recommendation:** 1 for P3–P4; raise to `4` in P6 with the same lease rules per session
and a visible "3 attached" counter in the header. Default assumed: **1**.

### Q-06 — Is mirror mode in v1?

Yes in this plan (P2, before attach) because it is the safe, immediately useful slice and
it exists in the CLI↔web story either way. It could be dropped to shorten the path to
driving-from-browser, but then the first thing a user can do is the risky thing.

**Recommendation:** keep mirror first. Default assumed: **mirror in v1, P2**.

### Q-07 — Diff review in v1?

The plan puts the read-only diff *renderer* in P4 but git operations out of scope (N-11).
If reviewing changes from the phone matters to you, that is the highest-value P4
addition; if not, it can wait.

**Recommendation:** keep (it is a rendering exercise over pi's own `edit` results ✓, not a
new capability). Default assumed: **in, P4**.

### Q-08 — Theme sync with your custom pi theme

pi hot-reloads a user theme from `~/.pi/agent/themes/<name>.json` ✓. Do you want pi-web to
follow your current pi theme setting automatically (so terminal and browser always match),
or keep an independent toggle?

**Recommendation:** follow automatically with an override in settings. Default assumed:
**follow + override**.

### Q-09 — Relationship to existing pi web UIs

Ignore, borrow patterns from, or try to contribute upstream to `agegr/pi-web` (or the
server-side-workspace product at pi-web.dev ✓).

| Option | Notes |
|---|---|
| Independent (assumed default) | Our contract (no terminal pane, no editor, strict relay-only) is a genuine difference; the plan is written to be ours |
| Contribute upstream | Fastest to users, but we would give up the D-01/D-11 contract and the layering the requirement asks for |
| Borrow explicitly | Copy only proven details (list UX, xterm-free read-only viewer behaviours) and cite them in `prior_art.md` |

**Recommendation:** independent, with `prior_art.md` maintained as an honest comparison.
**Needs your call** if you would rather spend these 33–53 days on a PR to an existing
project instead.

### Smaller items, defaulted without asking

| Topic | Default |
|---|---|
| Embedded terminal | Never (D-11) |
| Telemetry | Never |
| Update check | Opt-in command only |
| Mobile PWA | After v1 |
| Multi-tab same session | Follower, not co-writer |
| Session delete | Trash, with confirm ✓ |
| Node vs Bun | Node ≥ 22.19 ✓, Bun optional |
| Licence | MIT, matching pi's ecosystem convention |
