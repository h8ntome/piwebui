# 02 — Transcript & markdown

### TRN‑01 · Critical · Transcript silently drops the oldest entries; no "load older"
**Location:** `features/Transcript.tsx`, `lib/store.ts` (`applySseEvent` snapshot branch),
`routes.ts` entries pagination.
**Symptom:** a session with 400 entries loads 300 and reports `entryTotal: 400`, `hasOlder: false`.
Nothing in the UI says the view is a fragment, and there is no way to reach the first 100 entries.
**Repro:** open `Question number 0…` fixture (400 entries) → first visible turn is
"Question number 50"; `GET /api/v1/sessions/:key/entries` returns `nextCursor: true`;
clicking one of those rows in Trajectory yields the toast *"That entry is not loaded in this view."*
**Expected:** an explicit "100 earlier messages — load older" control, or auto-load as you scroll up.
**Actual:** `nextCursor` is never read by the client and `hasOlder` is never assigned from the
snapshot, so both are dead.
**Fix:** set `hasOlder` from the snapshot/cursor and add a top-of-transcript "Load older" button
(the endpoint already supports cursor paging).
**Evidence:** `44-longsession-top.png`, `18-tree-goto.png`

### TRN‑02 · High · Tool output has no height cap
**Location:** `features/ToolCall.tsx` `.pw-ioText` (no `max-height` for the bash `out` section).
**Symptom:** a 400-line shell result renders all 400 lines inline (single card ≈ 6 000 px), so one
verbose command buries everything below it.
**Expected:** collapsed to ~300 px with an internal scroll or "show all N lines".
**Actual:** unbounded growth; `.pw-toolBlock__list { max-height: 320px }` exists in CSS but is
never used by this component.
**Fix:** wrap `out` in `.pw-toolBlock__list` (already styled for exactly this) or add
`max-height: 60vh; overflow: auto` + a line-count affordance.
**Evidence:** `08-tools-expanded-1.png`

### TRN‑03 · Medium · Auto-scroll can leave the newest line behind the sticky composer
**Location:** `Transcript` effect (`el.scrollTop = el.scrollHeight`) + `.pw-main__composerSeat`
(`position: sticky`, gradient fade).
**Symptom:** while streaming with the queue dock open, the scroll position sat 67 px short of the
bottom and the newest row (bottom 771) ran under the composer seat (top 724).
**Expected:** the newest line is always fully visible above the composer.
**Actual:** transient occlusion of exactly the line you are watching.
**Fix:** give `.pw-main__chat` a `padding-bottom` equal to the composer+dock height (measure with
the existing ResizeObserver) or scroll the last element into view with `block:'end'`.
**Evidence:** `22-streaming-queue.png`, `23-steer.png`

### TRN‑04 · Low · Aborted run shows a lonely "stopped" chip and no partial output
**Location:** `Transcript` (`v.runtime.lastSettled.aborted`), `.pw-answer__stopped`.
**Repro:** start a long run, press `Ctrl+.` or the stop button.
**Actual:** after ~350 px of empty space, a small grey "stopped" pill; if nothing streamed yet the
assistant turn is visually empty.
**Fix:** attach the marker to the turn it belongs to ("Run stopped after 4.2 s") and keep any
partial text visible with a truncated style.
**Evidence:** `25-abort.png`

### TRN‑05 · Low · Preview objects accumulate; `hasOlder`/ghost-row risk
**Location:** `store.ts` `nv.previews` (pruned only when `mappedEntryId` arrives).
**Symptom:** after a handful of exchanges the view held 11 preview objects for ~6 messages.
**Fix:** prune previews whose `done` flag is set and whose entry landed, on each `runtimeState`.

### MD‑01 · High · Markdown task lists render as big text inputs
**Location:** `lib/md.ts` `ALLOWED_ATTR` (no `type`), `styles/transcript.css`.
**Symptom:** `- [ ] todo` / `- [x] done` become two identical **189 × 30 px text boxes** that a
user can type into inside the transcript; checked state is indistinguishable.
**Repro:** open the "Show me every markdown feature at once" fixture, scroll to the task list.
**Expected:** small disabled checkboxes, ✓ for done.
**Actual:** `input[type=text]` (default type after sanitiser strips `type="checkbox"`).
**Fix:** add `type` to `ALLOWED_ATTR` (or rewrite task items to a styled span) and style
`input[type=checkbox]` at 14 px with `accent-color`.
**Evidence:** `03-markdown-h1.png`, `04-markdown-mid.png`

### MD‑02 · High · Language-less code fences are mislabelled and mis-highlighted
**Location:** `features/Markdown.tsx` — `highlightWithin(root)` runs *before* the code-card upgrade,
and the upgrade derives the label from `language-*` classes that highlight.js just added.
**Symptom:** a fence with no info string (and 4-space indented code) is titled **"css"** (or
**"lua"** in real sessions) and prose gets random keyword colours — e.g. `a`, `line`, `all` turn
red in a plain-English block; a shell transcript turns into Lua comments.
**Repro:** markdown fixture (second and third blocks) → DOM shows
`code class="hljs language-css"`; real session `pi-web --version → …` came back `language-lua`.
**Expected:** unlabelled blocks render as plain text (or auto-detect is disabled).
**Fix:** capture the declared language *before* highlighting; only show a header when a language was
explicitly declared; skip `hljs.highlightElement` auto-detection (use `highlight(text,{language})`).
**Evidence:** `05-markdown-late.png`, `18-tree-goto.png`

### MD‑03 · Medium · H4/H5/H6 are typographically identical, H1 barely larger than H3
**Measured:** 21 / 19 / 18 / 14 / 14 / 14 px (600 weight for 4–6) at the default 14 px content size.
**Expected:** a monotonic, distinguishable scale.
**Fix:** e.g. 22/19/17/15/14/13 with decreasing weight and letter-spacing; at minimum differentiate
H4–H6 from body text.
**Evidence:** `03-markdown-h1.png`

### MD‑04 · Medium · Raw markdown leaks into Trajectory previews and tree labels
**Symptom:** tree rows show `**Error turn.** The model refused.`, `[thinking]`, `[toolCall]`,
`[?]`, `custom`, `message` — internal shapes, not user language.
**Fix:** strip markdown emphasis for previews, map entry types to readable labels ("Reasoning",
"Tool call", "Unreadable line"), and never show the literal word `message`.
**Evidence:** `14-panel-tree.png`, `31-error-states.png`

### MD‑05 · Low · Blockquote has no bottom margin
`.pw-md blockquote { margin: 16px 0 0 }` → a table or list directly after a quote is cramped
against it. Use `margin: 16px 0`.
**Evidence:** `04-markdown-mid.png`

### MD‑06 · Low · No affordance for horizontally scrollable code
Long single-line output inside a code card is clipped (`scrollWidth 1232` vs `clientWidth 694`)
with no fade, scrollbar hint or wrap toggle; `.pw-codecard--wrap` exists in CSS but nothing ever
applies it. Either wire the wrap toggle to the Settings (Code) tab or add a right-edge fade.
**Evidence:** `05-markdown-late.png`

### TOOL‑01 · Medium · Diffs are "all deletions then all additions", and the tinting is asymmetric
`ToolCall.DiffLines` prints every `oldText` line then every `newText` line: no context, no
alignment, and `removed` lines are red text with no background while `added` lines get a full-width
green band. For multi-edit calls the "● removed ● added" legend repeats per edit block.
**Fix:** use a real line diff (Myers/LCS over lines is ~40 lines of code), symmetric backgrounds,
one legend per tool card.
**Evidence:** `10-tools-diff.png`

### TOOL‑02 · Medium · Inconsistent input/output grouping between tools
`bash` renders one card with an `in`/`out` pair separated by a divider; every other tool renders
**two separate rounded cards** with a gap. Same information, two layouts.
**Fix:** single `pw-ioCard` with the divider for all tools.
**Evidence:** `09-tools-expanded-2.png`

### TOOL‑03 · High · Structured (non-array) tool results are silently dropped
`store.toolsFromEntries` only keeps `content` when `Array.isArray(content)`; an object payload
(`{"structured":true,…}`) becomes `outputContent: undefined`, so the expanded card shows only `in`
and the `out` block never appears. Data loss with no indication.
**Fix:** fall back to `safeJson(content)` for non-array content (the renderer `contentText` already
does this).
**Evidence:** `09-tools-expanded-2.png`, `10-tools-diff.png`

### TOOL‑04 · Low · Tool title casing is inconsistent
`TOOL_TITLE` covers `read/write/edit/…` but not plain `search`, `question`, `ask_user`,
`str_replace_editor` (title falls back to the raw snake_case name, e.g. "search", "mystery_tool")
while the neighbours read "Read", "Subagent". Unknown tools also print the raw JSON argument object
as the summary. Normalise display names (`x → X`) and show `k=v` pairs for unknown tools.
**Evidence:** `07-toolstates.png`, `09-tools-expanded-2.png`

### TOOL‑05 · Low · Misleading "running" spinner on read-only sessions
A tool call with no matching result in a history session keeps `status = "running"` forever and
spins. In a file mirror it should read "no result recorded".
**Evidence:** `11-tools-running.png`

### TOOL‑06 · Nit · `0.0s` duration noise
Fast tools render `0.0s`; show the duration only above ~50 ms, or use `120 ms` formatting.
**Evidence:** `20-streaming.png`

### GEN‑04 · Medium · No dedicated empty-session state
A brand-new (0-entry) session renders the hero, so "session exists but is empty" and "no session
selected" are indistinguishable; the sidebar row says "untitled session".
**Fix:** keep the header/breadcrumb and show a session-scoped empty state with a hint
("Send the first message — pi will start in `<workspace>`").
**Evidence:** `19-new-session.png`
