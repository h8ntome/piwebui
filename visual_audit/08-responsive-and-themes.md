# 08 — Responsive & themes

### MOB‑01 · Critical · A panel left open on desktop destroys the phone layout
**Location:** `App.tsx` — `showPanel = !!settings.panel && (!narrow || phone)`; phone therefore
*forces the panel on*, and `panel` is persisted in `localStorage`.
**Repro:** on desktop open Trajectory (or any panel), then open the app at 390×844 (or resize).
**Measured:** `.pw-centerCol` width = **10 px**, `.pw-rightCol` = 360 px of a 390 px viewport,
sidebar drawer parked at x = −306. The chat, composer and hero are effectively gone; the panel's own
action icons sit at the very edge (the "Close panel" button lands at x≈378 of 390 and the tab icons
were clipped in the first capture).
**Expected:** on phones the panel is either never auto-shown, or a full-width bottom sheet with a
clearly visible close control; the chat must never be squeezed.
**Fix:** on `phone`, ignore `settings.panel` on load (or render it as an overlay sheet with
`inset-inline: 0` and a large close button), and clamp `panelWidth` to `min(panelWidth, vw − 32)`.
**Evidence:** `45-mobile-hero.png` (broken) → `46-mobile-hero-clean.png` (after finding Close panel)

### MOB‑02 · High · Composer can occupy 48 % of a phone viewport
`.pw-main__composerSeat` measured **402 px of 844 px** with an empty input (textarea stuck at its
336 px auto-grow cap — root cause in `CTL‑09`). Even without the bug, the composer card's padding
stack leaves a tall empty field on small screens.
**Fix:** on phones cap the textarea to ~5 lines, reduce card padding, and re-measure on resize.
**Evidence:** `46-mobile-hero-clean.png`

### MOB‑03 · Medium · Touch targets are below 44 px throughout the chrome
Sidebar icon buttons are 24–28 px, session rows 36 px, panel header icons 28 px, queue-dock rows
36 px; hover-only controls (`SB‑07`, `SPAC‑01`) do not exist on touch at all. Recommend ≥ 40 px hit
areas on `data-phone`, and always-visible row actions when the input modality is touch
(`document.dataset.inputModality` is already maintained for exactly this).

### MOB‑04 · Medium · Header crowds and truncates at phone width
At 390 px the header holds drawer button + `edge / edge` + read-only pill + up to three utility
icons, and the rightmost icon sits ~4 px from the viewport edge; long titles truncate very early
(`Readonly…`/`Renamed by audit` fits, most do not). On the read-only mobile view the placeholder
"Read-only view — this session has no running pi to control" wraps to two lines inside the field.
**Fix:** collapse the utility icons into one overflow menu below 480 px; shorten the read-only copy.
**Evidence:** `46-mobile-hero-clean.png`

### MOB‑05 · Low · Drawer details
The drawer itself is good (scrim, close X, closes on selection). Gaps: no swipe-to-close, no focus
trap verification, the drawer keeps the full-width 300 px sidebar so long paths/titles truncate
identically to desktop, and there is no way to reach the panels (files/tree/context) from the drawer
except by closing it.

### TAB‑01 · Medium · At 820 px the app silently drops to the icon rail
`useNarrow()` (< 900 px) forces `sidebarCollapsed` and hides the right panel. A tablet in portrait
therefore loses both the session list and the panel, with no visible reason (the collapse toggle is
not rendered — `SB‑04`) and the user's own setting is silently overridden on every resize
(`collapsed = !phone && (settings.sidebarCollapsed || narrow)`, so the rail stays after you widen
past 900 px again only if the persisted flag flips — it does not, but the *perceived* state does).
**Fix:** between 640–900 px keep a compact labelled sidebar (200 px) instead of the icon rail, and
re-evaluate the panel allowance.
**Evidence:** `48-tablet-820.png`

### DARK‑01 · High · Dark theme contrast failures
`agent-browser a11y` reports 21 `color-contrast` violations (sidebar `.pw-sessions__label` and every
`.pw-row__time`), and several more are visible but not caught: composer chips `thinking off` /
model name at `opacity: 0.5` (≈3.4:1 against the card), the disabled send glyph, and the panel's
`pw-row__desc` runtime notes. Fix by defining dedicated dark tokens for tertiary/caption labels
rather than lowering opacity of an already dim colour.
**Evidence:** `54-dark-session.png`, `38-settings-dark.png`

### DARK‑02 · High · The context meter is invisible in dark mode
See `CTX‑01`: the ring is `fill: black`, i.e. a black dot on a near-black header — the metric is
unreadable in dark and meaningless in light.

### DARK‑03 · Medium · Dark theme dialog/menuskim is too weak
`ZIDX‑02`: dialogs are barely separable from the page, and the frosted menu background lets
underlying text bleed through (context popover). Add an elevation token (surface + border + shadow)
for dark.

### DARK‑04 · Low · Light/dark parity check
Beyond contrast, both themes render identically otherwise (spacing, icons, code cards); the only
asymmetry found is the meter (`DARK‑02`) and the scrim (`DARK‑03`). Light↔dark switching through the
Settings Choice is instant and persists across reloads. The `Follow system` path (a
`prefers-color-scheme` change listener in `App.tsx`) was verified by code and by emulating dark via
stored settings, **not** by flipping the browser's own media emulation — see
`11-untested-and-limitations.md`.

### THEM‑01 · Low · Theme choice silently overrides the OS while "Follow system" is on
`applySettings()` also forces `document.documentElement.dataset.inputModality = "pointer"` on every
settings change, which discards a detected keyboard-modality and can re-show pointer-only styling
after a theme change. Minor, but it makes `:focus-visible` styling inconsistent after theme toggles.
