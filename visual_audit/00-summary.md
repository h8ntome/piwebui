# 00 — Summary & priorities

**Verdict:** the shell, theming and control-plane plumbing are genuinely good — booting is clean,
no console/page errors were ever observed, Web Vitals are excellent (FCP 60 ms, LCP 156 ms,
CLS 0.00), streaming, queueing, steering, abort, rename and settings all work end to end, and the
light theme reads as a deliberate design. What is *not* production-quality yet is the content
layer: the transcript wastes ~40 % of its area on invisible rows, markdown rendering is wrong in
three separate ways, the Trajectory panel is unusable on any real session, image attachments
throw a raw Node error, and much of the polish loss comes from state that is fetched once and then
never refreshed. **113 distinct issues** are documented; 6 Critical, 18 High.

## Counts (machine-verified from the area files)

| Severity | Count | Notes |
|---|---|---|
| **Critical** | 6 | ATT‑01, TRJ‑01, TRN‑01, ZIDX‑01, MOB‑01, SRV‑02 (same root as TRN‑01) |
| **High** | 18 | ATT-class plus CTL‑02, CTL‑03, SPAC‑01, MD‑01, MD‑02, TOOL‑03, CTX‑01, SB‑01, SB‑02, SB‑04, TRJ‑02, WS‑01, MOB‑02, DARK‑01, DARK‑02, TRN‑02, A11Y‑01 |
| **Medium** | 53 | spread across every area |
| **Low / Nit** | 36 | copy, spacing, micro-interactions |
| **Total documented issues** | **113** | plus 2 informational entries (PERF‑03, SRV‑09) |

Distribution by area: transcript/markdown 18 · settings/dialogs/workspaces 15 · a11y+perf 14 ·
composer/control 13 · sidebar 13 · layout/spacing 12 · responsive/themes 11 · right panel 10 ·
server/API 9.

## Top 10 fixes, in the order that buys the most polish per hour

1. **ATT‑01 — image attachments are broken.** Client sends `dataBase64`, the pi host reads `im.data`
   (`packages/pi-adapter/src/host/main.ts:535`) → `Buffer.from(undefined)` TypeError is shown to the
   user verbatim and the message is lost. One-line field mapping + a friendly error copy.
2. **SPAC‑01 — stop reserving 44 px of invisible action row under every assistant turn.**
   `.pw-answer__actions` is `opacity:0` but keeps `height:28 + margin-top:16`; the transcript is
   half whitespace and the "Show timestamps" setting looks broken. Reveal on hover *without*
   reserving the space (absolute overlay in the gutter).
3. **TRJ‑01 — cap Trajectory indentation.** A linear 300-entry chain reaches `padding-left:
   3594px` inside a 379 px panel: rows are literally off-screen. Fold depth (e.g. collapse
   linear runs, or `min(depth, n)` + a "N levels deep" marker).
4. **ZIDX‑01 — dialogs and floating menus render under the right panel.** `elementFromPoint()`
   inside the open Settings dialog returns a `.pw-row` from the Trajectory panel. Fix the portal
   z-index/order once and it fixes toasts/menus/tooltip overlap class of bugs.
5. **TRN‑01 — surface (and honour) transcript pagination.** A 400-entry session loads 300 entries,
   reports `hasOlder:false`, ignores `nextCursor`, and shows nothing about the missing 100;
   clicking them in Trajectory yields "That entry is not loaded in this view."
6. **MD‑01/MD‑02 — markdown correctness:** `- [ ]` becomes a 189×30 px *text input* (DOMPurify
   strips `type`), and language-less fences are auto-detected and then labelled as the wrong
   language (`css`, `lua`) with wrong highlighting applied to prose.
7. **CTL‑02 — refresh models/commands when the runtime becomes ready, and after `setModel`.**
   Today a browser-created session shows "No model catalogue (no owning runtime)" forever, the
   model chip keeps the old model after a successful switch, and the menu ticks the old row.
8. **MOB‑01 — never let the right panel take a phone viewport.** Persisted `panel` + 380 px width
   squeezes `.pw-centerCol` to 10 px; the chat is gone. On phone the panel should be a bottom
   sheet (or force-closed) regardless of the desktop setting.
9. **SRV‑01 — `pi-web allow` must work while the server runs** (or the docs/CLI must say a restart
   is required). Today the natural "start pi-web, then allow a folder" order shows nothing at all.
10. **CTA/CTX‑01 + A11Y‑01 — the context meter is a solid black dot and 21 nodes fail contrast.**
    `.pw-meter__track`/`.pw-meter__fill` have no CSS at all (so both circles are `fill: black`),
    the header says `1%` while the popover says `0.9%`, and the sidebar timestamps/labels are below
    AA in both themes.

## Systemic themes (fix the pattern, not the instance)

- **"Fetch once, never refresh."** models/commands at open time (`CTL‑02`), session list capped at
  200 with the cursor ignored (`SRV‑02`), workspace allowlist read only at boot (`SRV‑01`), tree
  state left stale when a fetch fails (`TRJ‑02`).
- **Invisible-but-present UI.** Hover-revealed actions reserving layout (`SPAC‑01`), tooltips
  clipped above the viewport (`SET‑04`), dead `.pw-codecard--wrap` / `.pw-toolBlock__list` CSS
  (`TRN‑02`, `MD‑06`), unused `MODE_BADGE` (`SB‑01`), and the unreachable `InvalidRow` component
  (`SRV‑04`).
- **Raw internals leaking into copy.** `no tree source` (`TRJ‑02`), `undefined/undefined`
  (`PNL‑02`), `unavailable` (`SRV‑06`), `**Error turn.**` in tree previews (`MD‑04`),
  `Failed to fetch` (`SRV‑08`), `The first argument must be of type string or an instance of
  Buffer…` (`ATT‑01`). One shared "humanise" helper would cover all of them.
- **Two sources of truth for the same metric.** `1%` vs `0.9%`, `98k` vs `100k` tokens,
  "1000 entries/page" vs 200/300 actual, `history` vs `mirror` labels (`GEN‑05`).

## Areas that are in good shape

- Boot path, retry-on-error screen, and recovery when the API comes back (`56-boot-error.png`).
- Live plumbing: streaming preview, tool state folding, queue counts, steer/follow-up, abort with a
  "stopped" marker, rename propagation to header + sidebar, SSE `snapshot`/`entry`/`preview`
  handling, control-grant renewal (no 403s observed across ~50 minutes and many commands).
- Settings actually change behaviour (fonts, panel width, theme, grouping, filters) and persist.
- No horizontal page overflow at 390/820/1440; no layout shift; no console errors, ever.
- Read-only sessions are honestly labelled and the composer explains why it is disabled.

See `11-untested-and-limitations.md` for what was not covered (bridge/live-terminal mode,
multi-tab control contention, TLS/reverse-proxy paths, keyboard-only flow, real provider runs).
