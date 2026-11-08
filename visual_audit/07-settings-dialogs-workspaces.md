# 07 — Settings, dialogs, toasts, workspaces

### SET‑01 · Medium · Keyboard reference is incomplete and can contradict the settings
`Settings ▸ Keyboard` lists 8 shortcuts but omits `Ctrl/⌘+,` (Settings) and `Ctrl/⌘+R` (rename),
both of which are implemented — and `Ctrl+R` additionally overrides the browser reload (`CTL‑12`).
The `Enter` / `Shift+Enter` rows are static and describe the opposite of what happens when
"Enter sends" is off.
**Fix:** generate the list from the handler table, reflect the current `sendOnEnter` value, and add a
type-to-search filter for shortcut discovery.
**Evidence:** `37-settings-keys.png`

### SET‑02 · Medium · "Reset interface settings" is unconfirmed and drops your place
One click wipes `localStorage`, then `window.location.reload()`: theme, font sizes, panel choice
**and** `lastSessionKey` reset, so you land on the hero instead of the session you were reading.
**Fix:** confirm ("This resets appearance and reloads the page"), and keep `lastSessionKey`.
**Evidence:** `36-settings-about.png`

### SET‑03 · Medium · Toasts sit top-centre over the header and fight the other indicator
Toasts render centred at the top and cover the breadcrumb, the context meter and the panel toggles
(`18-tree-goto.png`, `53-image-sent.png`, `19-new-session.png`), while the "stream disconnected"
indicator uses bottom-centre. Two floating positions, both over content.
**Fix:** one corner stack (bottom-right is the least occupied), with max-height + collapse for
repeats, and make sure it does not overlay the header controls.

### SET‑04 · Medium · Tooltips on the top row are clipped off-screen
**Measured:** hovering `Files panel` at 1440×900 places the tooltip at `y = -21` (fully above the
viewport). Every header icon (`Session info`, `Files panel`, `Toggle right panel`, context meter)
has the same problem, so their labels are effectively invisible; the clipped tooltip is the dark
sliver visible at the top of `12/13/14/15-*.png`.
**Fix:** flip tooltips below the anchor when there is not enough room above (the `Tip` component
supports `side`; the header should pass `bottom`, or measure).
**Evidence:** `30-context-meter.png`, `12-panel-session.png`

### SET‑05 · Low · Stepper control ergonomics
No direct text entry for `Content size / Code size / Right panel width` (stepping 380→720 needs 17
clicks), the disabled up/down arrows are barely distinguishable, and the value/unit readout is
jammed against the arrows. Under very fast programmatic double-clicks one increment was lost
(handler uses the render-time `value`), worth an updater function `set(s => …)` for safety.
**Evidence:** `34-settings-appearance.png`

### SET‑06 · Medium · About tab mixes honest data with a misleading limit
Correct: `pi-web 0.1.0`, `Pi adapter 1.5.0 · tested`, `Managed runtimes 1 / 4`, `Workspaces 5
allowlisted`, `Sessions visible 31`. Wrong/misleading: `Limits 1000 entries/page` — the API actually
pages at 200 and the SSE snapshot window is 300 (`SRV‑02`). `Server features` is a raw comma list,
and there is no link to docs, repository, license or the source of the bundled Montserrat/DESIGN
tokens beyond one sentence.
**Evidence:** `36-settings-about.png`

### SET‑07 · Low · Settings nav details
The left rail uses `aria-current="false"` on inactive items (noisy for AT), has no arrow-key
navigation, and the visual "selected" state is a faint background only. The dialog also cannot be
resized, while its content pane scrolls without any scroll affordance.

### WS‑01 · High · Adding a workspace gives feedback that disappears into nowhere
**Repro:** sidebar ▸ Add workspace ▸ pick any folder that has no sessions.
**Actual:** toast "Workspace subdir added" — and nothing else. Workspaces with no sessions never
appear in the sidebar (the group list is derived from `sessions`), so the allowlist entry is
invisible, there is no row to hang "New session here" on, and the only way to use it is the hero
chip. There is also no toast on failure of the *removal* path (see `SB‑08`), and the toast text omits
the path.
**Fix:** render empty workspace groups (with a "no sessions yet" row), toast with the path, and offer
"New session here" directly from the toast.
**Evidence:** `40-dirpicker.png`

### WS‑02 · Medium · Directory picker: path entry is hidden and lossy
* The breadcrumb renders `Home / ~` (the same directory twice) and segments are unlabelled.
* Typing a path requires discovering an unlabelled pencil icon (aria-label only, no tooltip).
* Submitting a bad path toasts "path does not exist" but throws away your typed path (the field
  reverts), so you must retype.
* There is no "Go" affordance for the *selected* folder distinct from the *browsed* folder, and the
  "Selected: x" hint appears in a place that is easy to miss (below the list).
**Evidence:** `40-dirpicker.png`

### WS‑03 · Low · Directory picker wastes vertical space
The list keeps a ~430 px tall empty box for three folders, while long directory listings (server
returns up to 2000 entries) are rendered without virtualisation.

### WS‑04 · Low · "Show hidden files" is a ghost toggle
Its state is conveyed only by a tiny check placeholder; there is no pressed state, so it is hard to
tell at a glance whether hidden entries are included.

### WS‑05 · Medium · Prompt dialog opens with no context and no validation feedback
`Rename session` starts empty for prompt-derived titles (`CTL‑06`), gives no length guidance, and
disabled "Save" (correct) is visually identical to the enabled outline button next to it. Enter
submits (good).

### HERO‑01 · Medium · Hero workspace chip uses full paths with inconsistent hints
The chip reads `/home/dev/piwebui` (label = path, see `SRV‑01`) while its aria-label says
`Workspace piwebui`; the menu's per-row hint mixes two abbreviation styles
(`~/…` when short, `…` + last 20 chars when long), producing `…dev/piwebui` style fragments.
**Evidence:** `01-desktop-hero.png`

### HERO‑02 · Low · Dashed composer border implies "nothing chosen"
In hero mode with a workspace already selected the card renders the `--pendingPick` dashed border,
which reads as an empty/unusable field; the dashed treatment should appear only when no workspace
exists.

### HERO‑03 · Low · Hero model/thinking chips are dead clicks
`Select model` / `thinking off` in the hero open a menu containing one disabled row ("No model
until the session starts"). Two clicks to learn nothing; render them as static hints or hide them
until a runtime exists.
