# 05 — Sidebar & navigation

### SB‑01 · High · You cannot tell controllable sessions from read-only ones in the list
`MODE_BADGE` (`managed: "M"`, `live: "L"`, `mirror: "F"`, `history: "H"`) is defined but never
rendered; the only mode signal is a `title` attribute on an invisible 12 px slot. The dot only
appears for busy/error sessions. So the list shows 30 identical-looking rows, and you discover a
session is read-only only after opening it (and finding the composer disabled — `CTL‑07`).
**Fix:** render a small mode chip or glyph per row (and reuse the same token in the header pill),
or filter tabs at the top of the list.
**Evidence:** `01-desktop-hero.png`, `19-new-session.png`

### GEN‑05 · Medium · The mode label for the same session changes over time
The API reported `mode:"history"` at boot and `mode:"mirror"` after the first refresh for the same
files, and the Session panel says `Mode: mirror / State: unavailable / Driver: file`. Two names for
one state, plus a raw enum ("unavailable") surfaced to users. Pick one vocabulary and translate the
enum ("No running pi").

### SB‑02 · High · Search with no matches shows the wrong empty state
**Repro:** sidebar ▸ search ▸ type `zzzznomatch`.
**Actual:** the list body shows the *first-run* empty state: "No sessions yet · Add a workspace
folder · or start the bridge in a terminal pi".
**Expected:** "No sessions match “zzzznomatch”" with a Clear button, keeping the workspace groups
visible.
**Evidence:** `42-search-empty.png`

### SB‑03 · Medium · Search UX details
* The search field's leading icon is labelled "Search sessions" but acts as "close search".
* `Esc` closes and clears (good) but there is no visible hint; there is no keyboard shortcut to open
  search and it is absent from the Keyboard settings list.
* Filtering happens on name + first prompt + cwd, which is good, but matches are not highlighted.
* Filtering the list does not affect `Alt+↑/↓` (see `SB‑09`).

### SB‑04 · High · Collapsed rail has no expand affordance
When collapsed the toggle button is not rendered at all (`Sidebar.tsx` renders it only when
`!collapsed`), so the 56 px rail contains four anonymous icons + the logo; the only ways back are
clicking the logo (which does not look like a control) or `Ctrl+B`. Tooltips do not appear until
hover, and the entire session list disappears with no dots/hints.
**Fix:** keep the collapse control in the rail (rotated), add a tooltip on the brand explaining the
click, and show a status dot for busy sessions in the rail.
**Evidence:** `49-rail-collapsed.png`, `39-settings-sidebar-collapsed.png`

### SB‑05 · Medium · A newly created session is not visible where you expect it
New sessions have no `modified` yet, so `(b.meta.modified ?? "").localeCompare(...)` sorts them to
the **bottom** of their workspace group (and the group itself can be sorted low). The user clicks
"New Session" and sees nothing new; the list does not scroll to the selection either.
**Fix:** sort undated/new sessions first, and `scrollIntoView` the selected row on change.

### SB‑06 · Medium · Session titles are the raw first prompt
Long prompts truncate mid-word ("I'll analyze this task. …"), a session whose first message was
`f\` renders as `f\`, and prompt-derived titles repeat identical rows ("List the files in this di…"
×3) that cannot be told apart. Combined with `CTL‑06` (rename starts empty) there is no path to a
readable title.
**Fix:** prefer `name` → first *user* line trimmed to ~40 chars → "Untitled session", and add a
relative-time secondary line to disambiguate identical titles.

### SB‑07 · Medium · Row actions are hover-only and the copy has no failure path
`Copy session path` uses `navigator.clipboard.writeText(p).then(() => toast.success("Copied"))`
with **no `catch`**: where clipboard permission is denied (non-secure context, unfocused document,
Firefox policy) the user gets no feedback at all and the console gets an unhandled rejection. Other
copy buttons use `copyText()` (with the `execCommand` fallback) — inconsistent.
Row buttons are also `opacity:0` until hover/focus-within, so keyboard users get an invisible focus
target and touch users never see them.
**Fix:** use `copyText()` everywhere with a "Copied"/"Copy failed" toast; reveal on focus too.

### SB‑08 · Medium · Workspace row menus/labels
* Group header shows the absolute path (see `SPAC‑06`), which pushes the ＋ and ⋯ buttons off narrow
  widths.
* Clicking a group header opens the Files panel for *whatever session is active* (or the first
  workspace) rather than the clicked workspace — `FilesTab` falls back to `workspaces[0]` when the
  active session has no workspace, so clicking workspace A can show workspace B's files.
* Removing a workspace shows no confirmation and no toast (the row just disappears), even though the
  menu warns "runs are not interrupted".
**Evidence:** `13-panel-files.png`

### SB‑09 · Low · `Alt+↑/↓` walks the unfiltered session list
`stepSession()` uses `sessions`, not the filtered/grouped `visible` list, so with a search active or
read-only sessions hidden you can land on an invisible session.

### SB‑10 · Low · Icon overload in the sessions header
Three 14 px icon buttons (search / sliders / project-add) sit next to a "Workspaces" label; the
sliders icon is used again in the footer for "More" with a completely different meaning, and the
"Trajectory" nav item uses a branch glyph that reads as "share". Use distinct glyphs and (on wide
layouts) labels.
**Evidence:** `01-desktop-hero.png`, `12-panel-session.png`

### SB‑11 · Medium · Collapsed sidebar keeps focusable content inside `aria-hidden`
`.pw-sessions` gets `aria-hidden={collapsed}` while its buttons remain tabbable (row buttons, row
actions). Screen readers skip them but keyboard focus still lands on invisible controls.
Fix: `inert` / `tabIndex={-1}` when collapsed.

### SB‑12 · Low · "More" menu duplicates panel toggles but not state
The footer ▸ Panels items toggle the same `settings.panel`, yet they are marked
`selected` — no visual checkbox styling distinguishes the active panel in that menu, and the menu
also duplicates the same sliders icon as the view-options control (`SB‑10`).
