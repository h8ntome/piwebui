# 09 — Accessibility, typography, performance

## Accessibility

### A11Y‑01 · High · axe-core: 21 contrast violations (serious)
`agent-browser a11y` (axe 4.12.1) on the light-theme session view: **4 violations, 31 passes**.
* `color-contrast` (serious, 21 nodes) — `.pw-sessions__label` ("Workspaces") and every
  `.pw-row__time` in the session list.
* `landmark-one-main` (moderate) — no `<main>`.
* `page-has-heading-one` (moderate) — no `h1`; the hero "Into the Unknown" is a `<span>`.
* `region` (moderate, **603 nodes**) — the entire transcript/sidebar content lives outside landmarks.
**Fix:** semantic shell (`<aside>` already exists; wrap the centre column in `<main>`, the panel in
`<aside aria-label="Session panels">`), one visually-hidden `h1` (e.g. the session title), and dark
label tokens (`DARK‑01`).
**Evidence:** axe output captured in this session; `01-desktop-hero.png`, `54-dark-session.png`

### A11Y‑02 · Medium · Non-semantic interactive elements everywhere
Session rows and tree rows are `div[role=button][tabindex=0]` that *contain* real buttons (copy, row
menu) — a button-inside-button pattern. Panel switching, tabs and the file browser use icon buttons
with aria-labels but no `aria-selected`/`tablist` (`PNL‑05`). The settings switches do use
`role="switch" aria-checked` correctly (good).

### A11Y‑03 · Medium · Hover-revealed controls are keyboard- and touch-hostile
`SPAC‑01`/`SB‑07`: copy buttons and timestamps appear on `:hover`/`:focus-within` only. Focus does
reveal them (`.pw-turn:focus-within`) — but because the row is a `div[role=button]` the tab order
lands on the row first, and on touch there is no hover at all
(`document.dataset.inputModality` is already tracked and unused).

### A11Y‑04 · Medium · Focus visibility not systematically verifiable; `Ctrl+K` into a disabled field
`Ctrl+K` focuses the composer even when the session is read-only and the textarea is `disabled` —
the focus lands on a control that cannot accept input, with no explanation beyond the placeholder.
Also `aria-hidden` on the collapsed sessions list keeps tabbable descendants (`SB‑11`).

### A11Y‑05 · Low · Status/error messaging is not announced
Toasts, the "stream disconnected" pill, and composer notices are visual only (no `role="status"` /
`aria-live` observed on them), so a screen-reader user gets no feedback after Copy/Rename/Send
failures such as `ATT‑01`.

## Typography

### TYPO‑01 · Medium · Bold text is faux-bold (no 600/700 font files shipped)
`/fonts/brand-font.css` declares only weights **300 / 400 / 500** (`montserrat-light|regular|medium`)
while the stylesheets request `font-weight: 600` (13 declarations) and `700` (6 declarations) —
headings, hero title, buttons, message `strong`. The browser synthesises bold, which looks smeared
next to the real medium weight, and is most visible in `Heading 1` and the "New Session" label.
**Fix:** ship 600/700 (or map the design tokens onto the three available weights).
**Evidence:** `03-markdown-h1.png`

### TYPO‑02 · Medium · Heading scale not monotonic (`MD‑03`)
21/19/18/14/14/14 px — H4–H6 are indistinguishable from each other and nearly from body copy.

### TYPO‑03 · Low · Mixed numeric/label formats
Context window `98k` in the model menu (÷1024) vs `100k`/`200k` in the meter (`tokens()` ÷1000);
percentages `1%` (header) vs `0.9%` (popover); sizes `23 B` / `391 KB` / `1.2 KB` (tool card) vs
`2.5 MB` (too-large message); times `just now` / `4m ago` / `2h ago` / `Nov 7` / `04:17 AM`
appear in different components with different formats. Standardise on one formatter set.

### TYPO‑04 · Low · Copy voice is inconsistent
Sentence case in most labels, but `WorkSpace` (view options), `In one list` next to `WorkSpace`,
`All sessions (show read-only)` vs `Controllable only`, `Rename…` vs `Compact context` vs
`Return to terminal`, ellipsis usage (`Settings…`, `Rename…`, but `Compact` has none although it is
immediate). One style guide pass: sentence case, ellipsis only when a dialog follows.

## Performance

### PERF‑01 · Medium · No response compression
`curl -H 'accept-encoding: gzip, br'` returns byte-identical bodies with no `content-encoding`:
JS **546 798 B**, CSS **98 079 B**, plus `icons.svg` 65 KB and Montserrat 61 KB ≈ **770 KB per
first load** (fine on loopback, painful over an SSH tunnel / tailnet, which is a documented
deployment mode in the README).
**Fix:** enable compression (Fastify `@fastify/static` `gzip`/`brotli`, or precompress at build).

### PERF‑02 · Medium · Single 547 KB JS chunk, no code splitting
Vite warns at build time (`Some chunks are larger than 500 kB`); `highlight.js/lib/common`,
`marked`, `dompurify` and the whole app ship eagerly before the first paint of the hero.
**Fix:** dynamic-import the markdown/highlight path (only needed once a transcript exists) and split
the right-panel tabs.

### PERF‑03 · Good · Runtime metrics
Measured on the audit instance: **FCP 60 ms, LCP 156 ms, CLS 0.0001/0.0043, TTFB 0.6 ms**, no long
layout shifts, API calls in the 1–12 ms range (`entries` page 92 KB in 12 ms). No console output or
page errors were ever produced by the app itself during the audit.

### PERF‑04 · Medium · Heavy synchronous DOM for long transcripts
Rendering 300 turns produced a 40 397 px scroll area with 300 `.pw-turn` nodes, each with a
hidden actions row; markdown + highlight.js run synchronously per message on mount, and
`Transcript` recomputes `buildRows`/`toolsFromEntries` on every `v` change (i.e. on every preview
patch while streaming). Streaming a long session therefore re-diffs the whole list per token batch.
**Fix:** virtualise (or window) the transcript, memoise row builds on `entries` identity, and cap
per-message highlight work for very long outputs (`TRN‑02`).

### PERF‑05 · Low · File preview injects the whole file
Opening a 100 KB text file injects 100 050 characters into a `<pre>` (`max-height: 60vh` visually,
but full DOM). With a 2 MB file it would be ~2 MB of text nodes. Add a client-side preview cap
(e.g. 200 KB) with "show more".
