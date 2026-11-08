# 06 — Right panel (Session · Workspace files · Trajectory · Context)

### TRJ‑01 · Critical · Trajectory is unusable on any real session (unbounded indentation)
**Location:** `features/RightPanel.tsx` `TreeTab.renderNode` — `paddingLeft: 6 + depth * 12`.
Pi sessions are a linear `parentId` chain, so depth grows with message count.
**Measured:** 294-entry real session → 300 rows, `max padding-left = 3594px` inside a 379 px panel
(panel body `scrollWidth 3667`, `clientWidth 379`). Visually: from the ~12th row onward the label
is off-screen and you see only connector glyphs; the newest (most relevant) rows are unreadable.
**Expected:** a readable tree in a fixed-width panel — collapse linear runs into a single
"… 47 messages …" segment (expandable), and/or cap indentation with a depth indicator, and/or
horizontal scroll that actually works.
**Repro:** open any session with > ~20 entries ▸ Trajectory.
**Fix:** compress chains of single-child nodes; keep 2–3 visible levels; add a "reveal current leaf"
button (the current leaf highlight is currently the only orientation cue).
**Evidence:** `17-tree-big.png`, `14-panel-tree.png`, `25-abort.png`

### TRJ‑02 · High · Tree keeps the previous session's data and errors on empty sessions
**Repro:** with Trajectory open, click sidebar ▸ New Session.
**Actual:** a red toast **"no tree source"** and the panel still shows the *previous* session's tree
("1 root(s) · 300 entries") — `setTree` is only called on success, so a failed refresh leaves stale
content; an empty session is a normal state and should not raise an error.
**Fix:** clear the tree on `keyName` change before fetching, and render an empty state
("No entries yet") instead of toasting `no tree source`.
**Evidence:** `19-new-session.png`

### TRJ‑03 · Medium · Tree rows only work for loaded entries
Clicking a row dispatches `pw:goto-entry`; for anything outside the loaded window the only feedback
is a warning toast (see `TRN‑01`). There is also no keyboard hint that rows are clickable, and the
explanatory footer sentence ("Highlighted row is the current leaf — the point the next message is
appended to.") is always visible and eats 3 lines.

### PNL‑01 · Medium · Workspace files: no refresh, no live update
Tree and Context have a reload button; Files does not. Because the panel only reloads on
mount/session change, files created by the running session never appear until you switch tabs. The
server also caps a directory at 500 entries (`files.ts` `slice(0, 500)`) with **no** truncated flag,
so large directories look complete.
**Fix:** add the reload control (parity), watch the workspace (or poll when the panel is open), and
propagate a `truncated` flag.

### PNL‑02 · Medium · Context tab shows `undefined/undefined` for the model
`ContextTab` renders `ctx.model?.name ?? \`${ctx.model.provider}/${ctx.model.modelId}\`` — when
`model` is present but its fields are empty (persisted projection for a mirror session) you get
"undefined/undefined" (`15-panel-context.png`). Use `—` (already used for `Window`).

### PNL‑03 · Medium · "Show the prompt" dumps raw JSON with nested scroll regions
Each message card shows `[{"type":"text","text":"Show every tool state"}]` inside a 140 px
`max-height` box, so a prompt view becomes a column of tiny scroll areas inside the panel scroll
area; there is no copy button, no token estimate, no system prompt shown, and role labels are raw
camelCase (`toolResult`).
**Fix:** render `content` as text (block-aware), one scroll container for the whole list, copy-all,
and label roles consistently.
**Evidence:** `16-context-prompt-open.png`

### PNL‑04 · Medium · Session tab leaks internal enums and mixes placeholders
`State: unavailable`, `Mode: mirror`, `Driver: file`, then `Pi: —`, `Cost: not reported`,
`Session: not created yet`. Different placeholder vocabularies in one list, and `unavailable` as a
user-facing state.
**Fix:** a single `label()` map (`mirror → "Terminal session (read-only)"`,
`unavailable → "Idle"`), consistent `—` placeholder.
**Evidence:** `12-panel-session.png`, `15-panel-context.png`

### PNL‑05 · Low · Panel tab icons are ambiguous and not tab-like
The four panels are switched by three icon buttons in the header (`branch-outline` reads as
"share", `data-outline` reads as "print/stack"), with no `tablist` semantics, no visible selected
state, and no way to reach the fourth panel that is currently the header's active tab. Add
`role="tab"/aria-selected` (or at least aria-current), and give the current panel a highlighted icon.
**Evidence:** `12-panel-session.png`, `13-panel-files.png`

### PNL‑06 · Low · Panel width changes are not draggable
`Right panel width` only exists as a 280–720 stepper in Settings; a drag handle on the divider is
the expected interaction and would remove an extra modal trip. Also note the panel width is applied
via `--pw-right-w` on the frame, so changing it re-lays out the transcript (fine) but there is no
visual feedback while stepping because the Settings dialog covers the boundary.

### PNL‑07 · Low · Download/log affordances duplicated but inconsistent
Session tab offers a "Session log" download link; the session row menu offers "Download log"; the
raw endpoint opens in a new tab with no filename hint and no size warning for multi-MB logs (a 3 MB
JSONL is downloaded inline).
**Evidence:** `12-panel-session.png`
