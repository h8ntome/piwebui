# 03 — Layout, spacing, density

### SPAC‑01 · High · Invisible action rows reserve 44 px under every assistant turn
**Location:** `features/Transcript.tsx` `.pw-answer__actions.pw-actions--reveal`,
`styles/transcript.css:29-33`.
**Measured:** `.pw-answer` = 68 px while its content is 24 px; the actions row is
`height: 28 px; margin-top: 16 px; opacity: 0`.
**Symptom:** every answer (and every 1-line tool turn) is followed by 44 px of dead space, so a
transcript of tool rows sits ~110 px apart for 24 px of content, and the scroll height of a
300-entry session is 40 397 px for what should be ≈ 25 000 px. It also makes the
**Show timestamps** setting look broken, because the timestamp lives in the same hidden row
(you must hover to see any time at all).
**Expected:** either visible metadata (time + copy) in the flow, or hover-revealed controls that do
not push content around; timestamps should honour their own setting.
**Fix:** absolutely position the actions row in the right/left gutter (opacity 0 → 1 on
hover/focus-within) and render `pw-actionTime` inline only when `showTimestamps` is on.
**Evidence:** `06-tools-collapsed.png`, `07-toolstates.png`, `49-rail-collapsed.png`, `54-dark-session.png`

### SPAC‑02 · Medium · ~100 px gap between the thinking row and the answer body
`.pw-turn { gap: 6px }` plus `pw-flow__content > * ~ * { margin-top: 4px }` plus the thinking
disclosure's own bottom space produce a large hole between "Thought · …" and the first paragraph
(`03-markdown-h1.png`). Tighten to 4–8 px.

### SPAC‑03 · Medium · Hero wastes the upper half of the viewport
The hero stack is vertically centred, so on 1440×900 there is ~380 px of nothing above
"Into the Unknown" and ~250 px below the composer, while the composer — the only actionable thing —
sits low. `01-desktop-hero.png`, `19-new-session.png`.
**Fix:** anchor the hero block at ~30 % of the viewport height (or top-aligned with generous but
bounded padding) and reduce the decorative headline's footprint.

### SPAC‑04 · Low · Right panel is mostly empty at the Session tab
With 9 KV rows + one button, the panel leaves ~500 px of blank space at 400 px width
(`12-panel-session.png`). Consider a min-width closer to 320 px by default, or letting the panel
shrink to content.

### SPAC‑05 · Low · Redundant headers
The Context tab repeats the word "Context" (panel header + in-pane title row,
`15-panel-context.png`); the file view repeats the path in the breadcrumb and again as a title row
(`51-file-deep.png`).

### SPAC‑06 · Medium · Sidebar labels use full absolute paths where a name was intended
`Workspaces` group headers read `/tmp/audit/edge`, `/home/dev/piwebui` while the hero chip aria
label and `Session ▸ Workspace` row use the basename. See `SRV‑01`/`WS‑01` for the root cause
(label persisted as the path). Long paths also push the row actions off the row.
**Evidence:** `01-desktop-hero.png`

### SPAC‑07 · Low · Trajectory row metadata is low-value and crowded
Every row repeats the same time (`02:15 AM` × 7) right-aligned and truncates the label at the same
moment; drop the per-row time except on hover/first-of-minute, and let the label use the freed space.

### GEN‑01 · Low · Boot "connecting" screen has no context
Just a spinner + "Connecting to pi-web…"; no server URL/port or version, which is exactly the
information you need when it is stuck (the error variant does show a hint). Add
`http://127.0.0.1:<port>` and the version once known.

### GEN‑02 · Low · Decorative-only headline and badge
"Into the Unknown" + a `local` pill carry no state (they do not change with the workspace, model or
connection). Either make them informative (e.g. show the active workspace here) or reduce them.

### ZIDX‑01 · Critical · Modals, menus and toasts paint *under* the right panel
**Location:** `ui/Portal.tsx` + `styles/layout.css` (`.pw-rightCol` creates a later stacking
context than the dialog portal).
**Proof:** with Settings open at 1440×900 and the Trajectory panel open,
`document.elementFromPoint(inside dialog)` returns `pw-row|DIV` (a tree row). Visually, panel text
("…nted row is the current leaf — the point the next message is…") is drawn on top of the dialog.
The same happens for the header context popover (transcript text visible through/over it,
`30-context-meter.png`) and the top-centre toasts overlap header controls.
**Expected:** dialogs/menus/toasts always above app chrome; a dimmed scrim that clearly separates
layers.
**Fix:** raise the portal container to a documented layer scale (e.g. scrim 1000, dialog 1010,
menu 1020, toast 1030) and ensure `.pw-rightCol`/`.pw-panel` do not create a competing stacking
context (`z-index` on `.pw-composer__seat: 9`, panel later in DOM).
**Evidence:** `38-settings-dark.png`, `39-settings-sidebar-collapsed.png`, `30-context-meter.png`

### ZIDX‑02 · Medium · No visible scrim in dark theme
The dialog scrim is a light-theme-friendly wash; in dark mode the dialog edge is nearly
indistinguishable from the page (`38-settings-dark.png`), so it does not read as modal. Raise the
scrim opacity / add a subtle border+shadow token for dark.

### CTX‑01 · High · Context meter renders as a solid black dot
**Location:** `features/MainColumn.tsx` `ContextTrigger` SVG — the classes `pw-meter__track` /
`pw-meter__fill` have **no CSS rules at all** (only `.pw-meter__bar/__segment/__row` exist), so both
`<circle>`s use the SVG default `fill: black; stroke: none`.
**Measured:** `track.fill = rgb(0,0,0)`, `fill.fill = rgb(0,0,0)`, `stroke: none`.
**Symptom:** the ring is a filled black disc at any percentage (and invisible on the dark theme);
the header shows `1%` while the popover shows `0.9%`; the popover's bar touches the panel edge with
no padding.
**Fix:** style the two circles (`fill:none; stroke-width:2; stroke: var(--dsw-alias-…)`) with the
progress arc via `stroke-dasharray`, and use one shared formatter so the trigger and the popover
agree (1 decimal or none, but identical).
**Evidence:** `30-context-meter.png`, `54-dark-session.png`
