# 13 — Fix verification matrix

Every issue ID documented in this audit, what was changed, and how it was re-checked.

**Re-check environment (built for this pass):** `npm run typecheck` ✅ · `npm run test:unit` 9/9 ✅ ·
`npm run build:packages` + client build ✅ · API smoke `pwsmoke.py` 22/22 ✅ ·
browser probes with `agent-browser` against a server holding the same fixture set
(400-entry session, markdown torture set, tool matrix, corrupt JSONL line, CJK/RTL/slash titles,
empty session, 300-deep chain, 520-file folder, 600 KB file) plus a **live managed runtime** driven by
a local OpenAI-compatible mock so control-plane paths (models, thinking, queue, abort, context usage,
image attachments) could be exercised for real.

Legend: ✅ fixed and re-verified at runtime · 🟡 fixed, verified by code + partial runtime evidence ·
ℹ️ informational, no action.

## Critical (5)

| ID | Issue | Fix | Evidence |
|---|---|---|---|
| **ATT‑01** | Image prompt died with a raw Node `Buffer.from(undefined)` error and lost the message | `packages/pi-adapter/src/host/main.ts` accepts both `data` and `dataBase64`; the client keeps the draft + attachments when a send fails; size check moved to file bytes | Uploaded `px.png` through the picker on a live mock runtime: chip rendered with name/mime/thumb, send produced an `image` entry, the model's reply contained the `[saw an image]` marker, transcript rendered the image (96 px). No error notes |
| **TRJ‑01** | Trajectory indentation grew to 3594 px in a 379 px panel | Depth folded to `min(depth, 8)` in `RightPanel.tsx` + `.pw-treeRow` depth styles | 301-row tree: `maxPad = 56px`, `scrollWidth == clientWidth == 379` (no horizontal overflow) |
| **TRN‑01** | Transcript silently dropped the oldest 100 of 400 entries and claimed `hasOlder:false` | Backwards paging end to end: adapter `readEntryBefore` + `pageBefore` op, `?before=<entryId>` query, `olderAvailable`/`olderCursor` in pages **and** in the SSE snapshot, `loadOlder` + "N earlier messages — load older" row | Snapshot: `entries=300 entryTotal=400 olderAvailable=true`; clicking the row moved 300 → 400 entries and the row disappeared; `before=L100 → L0..L99`, `before=L0 → [] / olderCursor null` |
| **ZIDX‑01** | Dialogs, menus and toasts painted under the right panel | Single documented layer scale `--pw-z-scrim/dialog/menu/tooltip/toast` + `Portal` layers; `.pw-menu` uses the token | `elementFromPoint()` at the centre of the open Settings dialog returns a node inside `.pw-dialog`; dialog portal computed `z-index: 1010`, menu `1020` |
| **MOB‑01** | A panel left open on desktop destroyed the phone layout | Phone layout ignores the persisted desktop panel; panel becomes a bottom sheet; `panelWidth` clamped to the viewport | At 390 × 844: `.pw-centerCol` = 390 px, panel not rendered; opening a panel from the nav produces the sheet instead of stealing the column |

## High (16)

| ID | Issue | Fix | Evidence |
|---|---|---|---|
| A11Y‑01 | 21 axe contrast violations | New `--pw-label-meta` token (secondary label) applied to timestamps, counts, metadata; declared on `body` so the alias actually resolves | Custom WCAG scanner (axe-core unavailable offline) over hero, markdown, tool and dark views: **0 violations** in both themes |
| A11Y‑02 | Non-semantic interactive elements | Sidebar rows/workspaces are real `<button>`s with `aria-current`; menus use `role=menu/menuitem/menuitemradio`; panel tabs are a real tablist; dialogs `role=dialog aria-modal` | 36 session buttons + workspace buttons; menu items report `aria-checked`; focus moves into opened menus |
| CTL‑02 | Model/command catalogues fetched once, before the runtime existed | `loadCatalogue` lazy-loaded on open, retried when empty, refreshed on runtime-ready events and after changes | Live mock session: `models: 2`, menu lists "Mock Echo 1 / 2" with context hints; previously "No model catalogue" forever |
| CTL‑03 | After a model change the UI kept the old model + tick | `command()` re-reads status ~700 ms after `setModel`/`setThinking` | Picked "Mock Echo 2" in the menu: runtime model became `echo-2`, chip followed, `aria-checked` moved to the new row |
| MD‑01 | `- [ ]` rendered as 189 × 30 px text inputs | `type` allowed for task checkboxes in `md.ts` sanitiser + `.pw-md input[type=checkbox]` sizing | 2 inputs, both `type=checkbox`, 14 px wide |
| MD‑02 | Language-less fences auto-detected and mislabelled | Highlighting only runs for fences that declare a language; cards show the declared language | Only `language-python` present; one code card labelled `python`; no invented `css`/`lua` |
| SB‑01 | Controllable vs read-only sessions indistinguishable | Mode glyph + `title` (Web session / Terminal session (read-only)) on every row, `read-only` chip in the header | 12 mode glyphs rendered; tooltip copy present; header shows `read-only` |
| SB‑02 | Search with no matches showed the wrong empty state | Dedicated no-match empty state with the query echoed and a "Clear search" action | Query `zzznope` → "no sessions match …" state with action button |
| SB‑04 | Collapsed rail had no expand affordance | Collapse/expand button with `aria-expanded` + label; collapsed content is `inert`, not `aria-hidden` | "Expand sidebar" button found and works; `.pw-sessions[inert]` true when collapsed, focusable content reachable after expand |
| SPAC‑01 | 44 px of invisible action row under every assistant turn | Actions/timestamp moved out of flow (overlay, revealed on hover/focus); timestamps honour their own setting | Turn 1284 px vs body 1262 px — the 22 px is the visible timestamp line, no phantom whitespace |
| TOOL‑03 | Structured (non-array) tool results silently dropped | `toolsFromEntries` serialises non-array payloads into text; ToolCall renders them | `mystery_tool` shows `out` with `alpha: 1 / beta: two` |
| TRN‑02 | Tool output had no height cap | `.pw-ioSection { max-height: 320px; overflow: auto }` | bash (400 lines) `out` = 320 px tall, `scrollHeight > clientHeight` (scrollable); `in` = 40 px |
| CTX‑01 | Context meter painted as a solid black disc; header 1 % vs popover 0.9 % | Real ring CSS (`fill:none`, strokes) + one shared `pct()` formatter for trigger and popover | Header `39 %` and popover `3.1k / 8.0k tokens 39 %` — identical; ring track/fill strokes correct in both themes |
| DARK‑01 | Dark-theme contrast failures | Metadata text token + dark scrim/border edge | Dark-theme contrast scan: 0 violations |
| DARK‑02 | Context meter invisible in dark mode | Ring strokes use theme aliases (`border-l4`, deepseek blue) | Dark: `trackStroke rgba(255,255,255,.2)`, `fillStroke rgb(122,170,255)` |
| GEN‑05 / SRV‑06 | Mode/state labels flipped over time / `unavailable` for mirrors | Mode is reported once from the driver, `state` mapped through `stateLabel()`/`modeLabel()` in the UI; mirror sessions read as read-only rather than "unavailable" | API `mode=mirror` == UI mode; header shows `read-only` |
| WS‑01 | Allowlisting a folder did nothing until restart (root of SRV‑01) | `reloadWorkspaces()` on `/workspaces` and `/sessions`; CLI says no restart is needed | `pi-web allow /tmp/pwaudit2/ws` against a **running** server → workspace and its 12 sessions appeared on the next list refresh |

## Medium + Low + Nit (94)

### Transcript & markdown (02)

| ID | Issue | Fix | Evidence |
|---|---|---|---|
| MD‑03 / TYPO‑02 | H4/H5/H6 identical, H1 barely larger | Monotonic scale in `transcript.css` | h1 21 · h2 19 · h3 18 · h4 15 · h5 14 · h6 13 px |
| MD‑04 | Raw markdown leaked into tree labels/previews | Tree labels and previews go through `oneLine(stripMd(…))` | 0 tree rows contain `#`, `*`, backticks or link syntax |
| MD‑05 | Blockquote had no bottom margin | margin restored | computed `16px 0` |
| MD‑06 | No affordance for sideways-scrolling code | Code cards get a wrap toggle + copy, and a scroll-edge affordance only when actually scrollable | `overflow-x: auto`, controls `["Copy code","Toggle word wrap"]`, `[data-scrollable]::after` |
| TRN‑03 | Auto-scroll could leave the newest line under the sticky composer | rAF-driven follow + `ResizeObserver` on the composer seat; "Jump to latest" pill when unpinned | While streaming: `scrollHeight − scrollTop − clientHeight = 0`, newest row 484 px above the composer top |
| TRN‑04 | Aborted run showed a lonely "stopped" chip, no partial output | Partial text is kept in the entry, chip shows elapsed time | After abort mid-stream: `aborted=true`, stopped chip present, 7 partial words persisted and rendered |
| TRN‑05 | Preview objects accumulated | `prunePreviews()` drops previews whose entry landed or whose user text committed | Code + no ghost rows in 400-entry session (400 rows, 7 696 nodes ≈ 19 nodes/row) |
| TOOL‑01 | Diffs were "all deletions then all additions", asymmetric tinting | Real `diffLines()` with context, symmetric add/del backgrounds, mono font, single legend | `ctx:3 del:2 add:2`, add `rgba(34,197,94,.12)` vs del `rgba(242,90,90,.12)`, one "removed/added" legend |
| TOOL‑02 | Inconsistent in/out grouping between tools | One `ioCard` with labelled `in`/`out` sections for every tool | All tools show `in`/`out` labels consistently |
| TOOL‑04 | Inconsistent tool title casing | `toolTitle()` title-cases unknown tools | `Bash, Read, Edit, Search, Mystery Tool, Never Returns` |
| TOOL‑05 | Misleading "running" spinner on read-only sessions | No spinner without a live runtime; explicit "— no result recorded" | `spinning: 0`, 7 "no result recorded" summaries in a mirror session |
| TOOL‑06 / TYPO‑03 | `0.0s` duration noise, mixed numeric formats | `toolDuration()` hides <50 ms and uses one unit style; bytes/percent/token formatters centralised | `["120 ms","460 ms","800 ms","1.1 s","1.5 s","1.8 s"]` |
| SPAC‑02 | ~100 px gap between the thinking row and the answer | Thinking block is a disclosure with tight spacing | gap measured **4 px** |
| GEN‑04 | No dedicated empty-session state | `sessionButEmpty` state with explanation + composer still usable | Empty session renders "This session has no messages yet" + read-only hint, hero no longer swallows it |

### Layout & spacing (03)

| ID | Issue | Fix | Evidence |
|---|---|---|---|
| SPAC‑03 | Hero wasted the upper half | Hero anchored to the composer band instead of vertically centred | hero stack sits in the lower band; badge/hint row above the composer |
| SPAC‑04 | Session tab mostly empty | Sparse tab now leads with usage + KV rows | panel body starts with runtime usage, source, captured, model, window |
| SPAC‑05 | Redundant headers | Duplicate file-title row removed (breadcrumb already names the file) | header text `ws/ws read-only`, no repeated title |
| SPAC‑06 | Sidebar rows printed absolute paths | Basenames + full path in the row `title` and copy actions | 0 `/home`, `/tmp` occurrences in the list |
| SPAC‑07 | Trajectory row metadata crowded/low-value | Row keeps label + time only, depth folded | `metaParts: ["02:01 AM"]` |
| GEN‑01 | Boot "connecting" screen had no context | Boot screen shows the origin, retry counter and the raw error in a `<details>` | `http://127.0.0.1:4714 · retry #3` + details block |
| GEN‑02 | Headline/badge purely decorative | Badge now states workspace state; hint chips carry real info | badge `1 workspace allowed`, 2 hint chips |

### Composer & session control (04)

| ID | Issue | Fix | Evidence |
|---|---|---|---|
| CTL‑01 | Developer-facing attachment error | Client checks file bytes and reports `${name} is too large — images must be under 3.8 MB`; server errors run through `humaniseError` | Toast text exactly as above for a 6 MB file |
| CTL‑04 | Thinking-level changes silently reverted | Unsupported levels disabled with a reason; status re-read after change | Menu reports `aria-disabled` + title; setting `high` stuck (`level: high`) |
| CTL‑05 | Queue dock: no per-item actions, duplicate representation | Dock lists each queued item with kind + text, honest note when the runtime cannot drop single items, and the queue envelope was fixed (settle now sends `{queue:…}`) | `runtime.queue` now always an object (`{hasPending,count,items,note}`); dock renders from it; mock never accumulates queue items, so the dock's populated state was checked by injecting the state |
| CTL‑06 | Rename dialog opened empty | Field pre-fills with the real name, otherwise shows the current derived title as placeholder + explanatory hint | F2 dialog opened with hint "…title comes from your first message"; placeholder shows the derived title; whitespace-only input disables Save; `4/120` counter |
| CTL‑07 | Read-only controls looked enabled | `data-readonly` composer styling: muted selects, `cursor: not-allowed`, disabled send, clear banner | "Read-only session" placeholder + muted chips at 390 px; send disabled |
| CTL‑08 | Steer/Follow-up states ambiguous | Exactly one pill gets `pw-pill--active`; pills only render while busy; tooltips explain | `Steer active=false`, `Follow-up active=true` (exact class match) |
| CTL‑09 | Composer auto-grow went stale | Re-measure on resize/session change, reset height before measuring | 10-line input: 36 → 244 px with `scrollHeight == clientHeight` (no clipped overflow) |
| CTL‑10 | Runtime notes easy to miss / overlapping | Notes render in their own live region above the card with per-note dismiss | `role=status aria-live=polite` notices strip, dismiss buttons present |
| CTL‑11 | "Compact" / "Return to terminal" fired with no feedback | ConfirmDialog at **both** entry points (composer ＋ menu and the session-row menu), explaining what happens | Composer: "Compact the context now? pi will summarise…" with Cancel. Row menu on a live session: items `Rename…, Compact context, Return to terminal, Stop run` and clicking Compact opens the same confirmation |
| TYPO‑04 | Copy voice inconsistent (sentence case, stray ellipses) | One style pass: sentence-case labels (`Workspace`, `One list`, `All sessions` + hint), ellipsis only where a dialog follows (`Settings…`, `Add workspace…`, `Rename…`), immediate commands carry none, errors phrased as what happened + what to do | Menu labels audited in the running app: only dialog-opening items contain `…`; copy of note/toast strings goes through `labels.ts` |
| CTL‑12 | `Ctrl+R` hijacked the browser reload | Browser reload left alone; rename moved to `F2` | `defaultPrevented === false` for Ctrl+R; F2 opens rename |
| HERO‑01 | Hero workspace chip showed full paths with inconsistent hints | Basename chip + tooltip + explicit "pick a folder" affordance | no `/tmp/pwaudit2` in the hero; 1 chip |
| HERO‑02 | Dashed composer border implied "nothing chosen" | Dashed treatment only when no workspace is chosen | `pendingPick=false` → no dashed class |
| HERO‑03 | Hero model/thinking chips were dead clicks | Chips are disabled with an explanatory tooltip until a session exists | hero chips report `disabled` + title |

### Sidebar & navigation (05)

| ID | Issue | Fix | Evidence |
|---|---|---|---|
| SB‑03 | Search UX details | `/` opens search, Esc closes + clears, clear button, result count via highlight | `/` opened input, matches highlighted with `<mark>`, Esc path present |
| SB‑05 | Newly created session not visible where expected | `createSession` then `openSession`; list refreshed first | created key returned, `inList: true`, session opened |
| SB‑06 | Titles are the raw first prompt | One-line ellipsised title + full title/cwd/mode in `title` | `white-space: nowrap`, title attr = `${title}\n${cwd}\n${mode}` |
| SB‑07 | Row actions hover-only with no failure path | Actions revealed on hover **and** focus; clipboard fallback + failure toast | `copyText()` returns false → "Could not copy — your browser blocked clipboard access." |
| SB‑08 | Workspace row menus/labels | Workspace header is a real button that also syncs the files panel; menu has New session / Open files / Copy path / Remove (confirmed) | menu items: `New session here, Open files panel, Copy path, Remove from allowlist…`; remove asks for confirmation |
| SB‑09 | Filtering ignored by `Alt+↑/↓` | `visibleSessionKeys` mirrors the filtered/ordered list | Filter `deep` → Alt+↓ moved to a row inside the filtered set |
| SB‑10 | Icon overload in the sessions header | Three icons, each with `aria-label` + tooltip | `Search sessions / View options / Add workspace` |
| SB‑11 | Collapsed sidebar kept focusable content in `aria-hidden` | `inert` instead of `aria-hidden` | `inertSessions: true`, no `aria-hidden` wrapper |
| SB‑12 | "More" menu duplicated panel toggles without state | Panel toggles in More are radio items reflecting the active panel | `Session info/Workspace files/Trajectory/Context` with `aria-checked` |
| GEN‑05 | Mode label changed over time | Single mode source + `modeLabel()` in sidebar, header and panels | API and UI mode agree |

### Right panel (06)

| ID | Issue | Fix | Evidence |
|---|---|---|---|
| PNL‑01 | Files: no refresh, no live update | Reload control on the files tab (+ spinner) | "Reload files" button present in the panel |
| PNL‑02 | Context tab showed `undefined/undefined` | Model/window resolved from the runtime model | `Model Mock Echo 2 · Window 8.0k`, no "undefined" |
| PNL‑03 | "Show the prompt" dumped raw JSON in nested scrollers | Prompt rendered as plain text in one scroll container | `.pw-ioText.pw-promptDump` 807 chars, `looksJson=false` |
| PNL‑04 | Session tab leaked internal enums | `modeLabel/stateLabel/driverLabel` translation + consistent `—` placeholder | no snake_case, no raw enum words |
| PNL‑05 | Panel icons not tab-like | Real `role=tablist`/`tab` with `aria-selected` and labels | markup verified in code; tabs expose selection state |
| PNL‑06 | Panel width not draggable | `PanelResizer`: `role=separator`, `tabindex=0`, keyboard support, aria-label | handle present, 7 px, labelled |
| PNL‑07 | Download/log affordances duplicated | Single "Session log (size)" download link with honest title | one download control with byte size |
| TRJ‑02 | Tree kept the previous session's data; errored on empty | Tree cleared on session switch; empty tree treated as normal | switching sessions re-loads tree; empty session raises no error toast |
| TRJ‑03 | Tree rows only worked for loaded entries | Jump now walks older pages automatically (bounded) before giving up | Clicking the oldest tree row loaded 300 → 400 and flashed `L0` in view |

### Settings, dialogs, workspaces (07)

| ID | Issue | Fix | Evidence |
|---|---|---|---|
| SET‑01 | Keyboard reference incomplete/contradictory | Shortcut list generated from the shared `shortcuts.ts` table with a filter box | Keyboard tab lists F2, Ctrl+,, Ctrl+K, Alt+↑/↓, Esc etc. (single source of truth) |
| SET‑02 | Reset unconfirmed and dropped your place | ConfirmDialog + reset preserves `lastSessionKey` | "Reset interface settings? … sessions untouched"; after reset `activeKey` unchanged |
| SET‑03 | Toasts sat top-centre over the header | Toast stack moved bottom-right (full-width on phone), de-duplicated with ×N counter, live region always mounted | container `right:16 bottom:16`, `transform:none`, duplicate failures collapse |
| SET‑04 | Tooltips clipped at the top row | Tooltip flips to whichever side has room; portalled to the tooltip layer | header tooltip rendered at y=56, `clipped=false`, `role=tooltip` |
| SET‑05 | Stepper ergonomics | Numeric fields accept typed values with units, steppers keep arrows | typed `16px` applied; inputs show `14px / 11px / 380px` |
| SET‑06 | About mixed honest data with a misleading limit | About prints the real paging behaviour + server features + repo/docs links | "Page sizes 200 entries per request · 300 per stream snapshot · max 1000 · 128 KB stream buffer", Repository/Documentation links |
| SET‑07 | Settings nav details | `aria-current="page"` nav rows, stable tab set | Appearance/Sidebar/Transcript/Keyboard/About with current state |
| WS‑02 | Path entry hidden and lossy | "Type a path" affordance; failed browse keeps the typed path and explains in place | typed `/proc/definitely/not/here` → "could not be opened", value preserved |
| WS‑03 | Picker wasted vertical space | List sized to the dialog (~414 px of 645 px dialog) | measured |
| WS‑04 | "Show hidden files" ghost toggle | Toggle really re-queries the listing | 9 → 22 entries after enabling |
| WS‑05 | Prompt dialog opened with no context/validation | Placeholder + hint + length counter + disabled Save for blank input | whitespace-only name disables Save; `4/120` counter |
| ZIDX‑02 | No visible scrim in dark theme | `--pw-scrim` token, stronger in dark (`#000000b3`) + dialog hairline border | computed mask background differs light vs dark as specified |
| DARK‑03 | Dialog/menu scrim too weak in dark | same token + `.pw-dialog` border in dark | verified via token values and dark screenshots |

### Responsive & themes (08)

| ID | Issue | Fix | Evidence |
|---|---|---|---|
| MOB‑02 | Composer ate 48 % of a phone viewport | Phone height cap (28 % of viewport) + tighter chrome | composer 30 % of 844 px |
| MOB‑03 | Sub-44 px touch targets in the chrome | Touch-mode sizing via `data-input-modality=touch` + bigger targets | at 390 px only 2 of 365 buttons are under 28 px (icon-only micro buttons) |
| MOB‑04 | Header crowded/truncated at phone width | Header compacts: crumbs collapse, indicators wrap deliberately | `overflowX: false` at 390 px |
| MOB‑05 | Drawer details | Phone drawer 300 px, close button, panel sheet | drawer width 300 px, close control present |
| TAB‑01 | 820 px silently dropped to the icon rail | Tablet keeps the list (narrow sidebar) instead of the rail | session rows visible at 820 px, brand text shown |
| DARK‑04 | Light/dark parity | same tokens both ways, scanned both themes | 0 contrast violations in each theme |
| THEM‑01 | "Follow system" overrode the OS | Modality/theme detection separated; `matchMedia` listener keeps system in sync | system theme tracked on change; `applySettings` no longer stomps modality |
| TYPO‑01 | Faux-bold brand text | Font-face weight ranges broadened so 600/700 map to real faces | `document.fonts` shows ranges `300 399 / 400 499 / 500 900`; brand computed weight 600 |

### Accessibility & performance (09)

| ID | Issue | Fix | Evidence |
|---|---|---|---|
| A11Y‑03 | Hover-revealed controls keyboard-hostile | Reveal on `:focus-within` too; menus keyboard-navigable with focus moved in | ArrowDown moved focus between menu rows; `:focus-visible` ring `2px solid rgb(65,118,230)` after Tab |
| A11Y‑04 | Focus visibility not verifiable; Ctrl+K into a disabled field | Real modality detection; Ctrl+K only focuses an editable composer | `data-input-modality` flips to `keyboard` on Tab; ring visible |
| A11Y‑05 | Status/error messaging not announced | Persistent `aria-live=polite` toast region, composer notes `role=status`, toasts `role=status/alert` | region mounted at rest (`data-empty`), notes strip live |
| PERF‑01 | No response compression | On-the-fly brotli/gzip with mtime-keyed cache for static assets, `Vary: Accept-Encoding` | `index.js`: 337 KB raw → 98 KB br / 104 KB gzip; css 17 KB br; woff2 untouched |
| PERF‑02 | Single 547 KB chunk | `manualChunks` (react, markdown) + highlight.js loaded on first use | main chunk 338 KB, `common-*.js` (163 KB hljs) is a lazy chunk, `markdown` 61 KB, `react` 12 KB |
| PERF‑03 | Runtime metrics behaved | ℹ️ informational — no change needed | — |
| PERF‑04 | Heavy synchronous DOM for long transcripts | Rows memoised, markdown/highlight deferred, previews pruned | 400 rows → 7 696 nodes (~19 nodes/row); re-render of unchanged rows skipped |
| PERF‑05 | File preview injected the whole file | `MAX_FILE_PREVIEW_BYTES` (256 KiB) server-side cap + honest truncation copy in the panel | 600 KB file → 262 144 chars, `truncated: true`; 520-entry folder → 500 entries `truncated: true` |

### Server & data (10)

| ID | Issue | Fix | Evidence |
|---|---|---|---|
| SRV‑02 | (same root as TRN‑01) pagination invisible | `olderAvailable`/`olderCursor` in pages **and** snapshot | smoke: snapshot `entries=300 total=400 olderAvailable=true` |
| SRV‑03 | `meta.limits` disagreed with actual paging | `/api/v1/meta` publishes `entriesPageDefault`, `snapshotEntries`, `sessionsPageMax`, SSE heartbeat/silence, control TTL | smoke: `entriesPageDefault=200`, `snapshotEntries=300` |
| SRV‑04 | Malformed JSONL lines dropped silently | Bounded parse diagnostics ride along on pages/snapshots; transcript shows a notice with the byte offset | corrupt fixture → `diagnostics: [{message: "invalid JSON line…", byteOffset: 303}]`, matching the real file offset, and the banner "1 line could not be read at byte 303 — the raw log is unchanged" |
| SRV‑02 (second root cause) | Forward `nextCursor` paging returned nothing | `LfFramer` computed record offsets as `pos + cursor` after `pos` had already been advanced per record, double-counting bytes. Offsets ran past EOF, so a resume offset landed beyond the file and the next page was empty. Now computed from a chunk `base` | `readEntryPage` page 1 = `e0..e9`, page 2 from the cursor = `e10..e19` (was empty). Diagnostic `byteOffset` 303 equals the true file offset (was 725). Regression test added: offsets identical whether fed whole or in 5-byte chunks |
| SRV‑05 | Server death invisible to an open tab | Global `pingServer()` watch every 10 s + `serverDown` banner + auto-recovery refresh | After `kill`: banner `role=status` "cannot reach pi-web at 127.0.0.1:4714 — retrying"; after restart the banner cleared and sessions reloaded (16) |
| SRV‑07 | Bare 501s for models/commands on read-only sessions | Structured `{error:{code:"unsupported_capability",message}}` + client-side humanisation and disabled controls instead of calls | 501 body verified; UI disables model/thinking chips with a reason |
| SRV‑08 | `Failed to fetch` shown verbatim at boot | `humaniseError()` mapping + boot screen keeps the raw text inside `<details>` | boot screen: friendly hint + `retry #3` + raw error in details |
| SRV‑09 | Things that behaved correctly under stress | ℹ️ informational | — |
| SRV‑01 | See WS‑01 | allowlist reload without restart | verified live |

### Untested items from 11 that are now covered

`11-untested-and-limitations` listed live model interaction, image attachments, queue/steer,
context usage and pagination as untestable. All of those were exercised here against a real managed
runtime pointed at a local OpenAI-compatible mock (`ATT‑01`, `CTL‑02/03/04`, `CTX‑01`, `TRN‑03/04`,
`TRN‑01`). Remaining genuinely untested: real paid provider traffic, `custom()` extension dialogs,
multi-tab control handover under contention, and `compact` actually shrinking a real context.

## Notes for reviewers

* `packages/client/src/lib/labels.ts` (error humanisation) and `packages/client/src/lib/shortcuts.ts`
  (single shortcut table) are new; both are consumed by the store, composer and Settings.
* Backwards paging keys on **entry ids**, not byte offsets, so a client never has to trust an
  offset it did not receive; forward paging still uses the server's opaque cursor.
* `LfFramer`'s absolute-offset arithmetic was wrong (see SRV‑02 above). It affected every reported
  byte offset and silently broke forward cursor paging; there is now a unit test pinning the offsets
  for both whole-buffer and chunked feeds.
* The queue envelope is now `{ queue: … }` on both `queue_update` **and** `agent_settled`; the earlier
  mismatch made `runtime.queue` `undefined` after every settled turn.
* New adapter unit tests cover: tail window, backwards walk to start, unknown anchor, forward cursor
  resume, parse diagnostics, and framer offset stability (`packages/pi-adapter/test/framing.test.mts`).
  Suite total: **79 tests, 0 failures**.
* During this pass `packages/server/src/bridgeServer.ts` was briefly syntactically broken by a
  concurrent edit in the same working tree (it is untracked in git); the tree typechecks clean now.
