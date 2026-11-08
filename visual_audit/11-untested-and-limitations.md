# 11 — Untested areas & audit limitations

**Coverage claim, stated honestly:** every *page, panel, dialog and menu* reachable in the running
app was opened and exercised at three viewport sizes, and the live control plane was exercised with
a real managed `pi` (mock provider). What follows is what was **not** verified.

## Not covered — needs setup this audit did not have

| Area | Why it was skipped | What could still be hiding |
|---|---|---|
| **Bridge / "live" terminal mode** (`mode: live`, `L` badge) | Requires starting a terminal `pi` with `PIWEB_BRIDGE_TOKEN` + the bridge extension. All sessions here were `history`/`mirror` (30) or `managed` (1). | Approval cards (`select` / `confirm` / `input` / `editor` in `Composer.ApprovalCard`) were **never rendered**; the observed-dialog list, `dialogResolved` handling, "terminal" pill, `stopForTerminal` behaviour, and `live`-specific capability copy are untested. This is the single largest untested surface. |
| **Control contention / multi-tab** | Only one browser tab was driven. | Second tab stealing control (`controlState`, `epoch` bumps), the re-acquire path in `store.command()`, and any "controlled elsewhere" banner. |
| **Runtime failure events** | Not inducible with the mock. | `hostExited` (managed pi crash/OOM) note, `conflict` (file changed under a mirror) note, `runtime.retry.active` row, `resync` path, queue `note` when `queue:"none"`. |
| **Real provider behaviour** | Deliberately avoided (cost, nondeterminism, private data). Usage/cost figures in Context are mock values; `tokens/cost` formatting was only checked against synthetic numbers. | Retry/backoff UX, real abort timing mid-tool, provider 429/500 copy, real context-window percentages, tool outputs with ANSI colours or very long single lines. |
| **`Compact context` execution** | Menu item present and enabled; running it needs a context long enough to compact. | Whether the compaction row renders live, progress state, and the `compaction.active` indicator. |
| **Session list > 200** | Audit instance had 31 sessions. | The `nextCursor` gap in `SRV‑02` (sessions beyond 200 silently missing) was proven from the API, not seen in the UI. |
| **TLS / reverse proxy / non-loopback binds** (`--tls-cert`, `--host-allow`, Origin allowlist) | Out of scope for a UI audit; would need certificates and a second host. | Host-fence error pages, mixed-content behaviour, cookie `Secure` handling. |
| **Screen reader & full keyboard walk** | No AT available in this environment; tab order was sampled, not walked. | Focus traps in dialogs/menus (open menu then Tab), reading order of the transcript, whether `aria-current` on the settings rail is announced, `Ctrl+K` into a disabled composer (`A11Y‑04`). |
| **Browser zoom (200 %), `forced-colors`, `prefers-reduced-motion`, RTL locale** | Not driven. | The shimmer/spinner animations respect nothing observed; reduced-motion would disable `.pw-shimmer__bar` only if it has a media query (not found). |
| **HiDPI / real display rendering** | Headless Chromium, `deviceScaleFactor = 1`. | Hairline borders (`--pw-hairline: .5px`), `corner-shape: round` and `backdrop-filter` quality on retina; subpixel text weight. |
| **Long-running stability (hours)** | Session lasted ~55 minutes. | Preview/notes growth (`TRN‑05`), SSE reconnect storms, memory of `views` across many sessions, SQLite WAL growth. |
| **`PromptDialog` for new-session naming** | Only the rename path uses it. | Same component, different labels — low risk. |
| **Print / PDF, PWA/mobile browser chrome** | Not applicable/not driven. | — |

## Limitations of the method

* Findings come from **one environment**: a throwaway data dir + agent dir under `/tmp/audit`, real
  (copied) session files plus synthetic fixtures, and a deterministic mock provider. Payload shapes
  that only real pi emits (e.g. tool results with images, multi-part ANSI output) were emulated, not
  observed.
* The working tree at audit time had uncommitted changes (client refactor: `api.ts`, `store.ts`,
  `sse.ts`, `md.ts` moved into `lib/`), so line references point at that state; the built bundle was
  freshly rebuilt (`npm run build -w @piwebui/client` + `scripts/stage-client-dist.mts`) so the UI
  matched the sources being cited.
* Severity is assigned by *user impact observed*, not by code risk.
* A few probes are React-batch sensitive (e.g. two `.click()` calls in the same tick lost one
  stepper increment — `SET‑05`); those are flagged as such rather than asserted as user-facing bugs.
* Screenshot names are the literal files in `screenshots/`; where an issue cites no screenshot the
  evidence is a DOM/CSSOM measurement or an API transcript recorded in the corresponding section.

## Suggested next pass (highest value per hour of effort)

1. Bridge mode: run a terminal `pi` with the extension and drive `live` sessions + all four dialog
   kinds end to end.
2. Two-tab control contention (acquire/renew/steal) and `hostExited`.
3. Keyboard-only walk + one screen reader pass (VoiceOver/NVDA) on the transcript and dialogs.
4. Re-run this checklist on a real provider session with >200 sessions and >1000 entries to confirm
   the pagination fixes.
