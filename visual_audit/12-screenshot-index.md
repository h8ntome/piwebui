# 12 — Screenshot index

All files live in `screenshots/`. Numbered in capture order; the primary evidence for each issue is
also cited inline in the area files.

| File | What it shows |
|---|---|
| `01-desktop-hero.png` | Hero at 1440×900: sidebar full paths, dead upper half, dashed composer, lone panel icon |
| `02-markdown-top.png` | Read-only session: long token wrap, code card header gap, disabled-but-saturated send button |
| `03-markdown-h1.png` | Heading scale (H4–H6 identical), task-list boxes rendered as text inputs, gap under "Thought" |
| `04-markdown-mid.png` | Tables, blockquote spacing, task inputs, python code card |
| `05-markdown-late.png` | Language-less fences labelled "css" with prose highlighted; clipped long code line |
| `06-tools-collapsed.png` | Tool row cadence showing the ~110 px spacing voids (`SPAC‑01`) |
| `07-toolstates.png` | Error tool (red), unknown tool raw JSON, running-state absence |
| `08-tools-expanded-1.png` | 400-line bash output with no height cap (`TRN‑02`) |
| `09-tools-expanded-2.png` | Two-card `in`/`out` for non-bash tools (`TOOL‑02`), raw JSON summary |
| `10-tools-diff.png` | Diff blocks: deletions then additions, asymmetric tint, repeated legend |
| `11-tools-running.png` | Tool call with no result spinning forever in a history session |
| `12-panel-session.png` | Session panel enums (`unavailable`/`mirror`/`file`), clipped tooltip sliver at top |
| `13-panel-files.png` | Files panel (no reload control), sidebar sync |
| `14-panel-tree.png` | Trajectory with 18 entries: raw type previews, per-row timestamps |
| `15-panel-context.png` | Context tab `undefined/undefined`, duplicated "Context" title |
| `16-context-prompt-open.png` | "Show the prompt" raw JSON cards with nested scroll areas |
| `17-tree-big.png` | **Trajectory unusable**: 300 rows, padding-left 3594 px in a 379 px panel (`TRJ‑01`) |
| `18-tree-goto.png` | "That entry is not loaded in this view." toast covering header (`TRN‑01`/`TRJ‑03`) |
| `19-new-session.png` | "no tree source" error toast + stale tree + tooltip pinned over nav (`TRJ‑02`) |
| `20-streaming.png` | Streaming "working" row, 0.0s duration, Steer/Follow-up pills, stop button |
| `21-queue-dock.png` | Queue dock (2 queued) overlaying transcript area |
| `22-streaming-queue.png` | Newest content behind the sticky composer/queue dock (`TRN‑03`) |
| `23-steer.png` | Steered message indistinguishable from a normal message |
| `24-steer-bottom.png` | Scroll at rest: composer flush to bottom, no overlap (control case) |
| `25-abort.png` | Lonely "stopped" chip after abort, deep tree indentation visible |
| `26-model-menu.png` | "No model catalogue (no owning runtime)" on a live managed session (`CTL‑02`) |
| `27-add-menu.png` | (capture aborted) ＋ menu reference frame |
| `28-add-menu.png` | ＋ menu: Image / Compact / Return to terminal |
| `29-rename-dialog.png` | Rename dialog opened with an empty field; "edge / edge" breadcrumb duplicate |
| `30-context-meter.png` | Header context meter as a solid black dot; popover clipped + content bleeding through |
| `31-error-states.png` | `isError` message rendered as normal text; raw markdown in tree previews |
| `32-invalid-image.png` | Assistant image render; missing "Unreadable entry" row (`SRV‑04`) |
| `33-compaction-open.png` | Compaction row expanded (works) |
| `34-settings-appearance.png` | Settings ▸ Appearance (light) |
| `35-settings-Sidebar.png` / `-Transcript.png` / `-Keyboard.png` / `-About.png` | The other four settings tabs |
| `36-settings-about.png` | About tab: misleading "1000 entries/page", reset button (`SET‑06`/`SET‑02`) |
| `37-settings-keys.png` | Shortcut list missing `Ctrl+,` and `Ctrl+R` (`SET‑01`) |
| `38-settings-dark.png` | Dark theme: dialog under panel content (`ZIDX‑01`), weak scrim (`ZIDX‑02`) |
| `39-settings-sidebar-collapsed.png` | Rail with no expand control; panel text painting over the dialog |
| `40-dirpicker.png` | Directory picker: "Home / ~", huge empty list area |
| `41-search.png` | Sidebar search active (1 match) |
| `42-search-empty.png` | Wrong empty state for a no-match search (`SB‑02`) |
| `43-view-options.png` | View options menu wording (`WorkSpace`, `In one list`) |
| `44-longsession-top.png` | 400-entry session starting at "Question 50": older entries unreachable (`TRN‑01`) |
| `45-mobile-hero.png` | **Broken phone layout**: panel takes 360 px, chat squeezed to 10 px (`MOB‑01`) |
| `46-mobile-hero-clean.png` | Mobile transcript with 402 px composer (`MOB‑02`) and dead gaps |
| `47-mobile-drawer.png` | Mobile drawer (works) with sub-44 px hit targets (`MOB‑03`) |
| `48-tablet-820.png` | 820 px tablet forced to the icon rail (`TAB‑01`) |
| `49-rail-collapsed.png` | Collapsed rail: four anonymous icons, huge inter-turn gaps |
| `50-file-view.png` | File preview in the panel (breadcrumb + title duplication) |
| `51-file-deep.png` | Deep file path navigation (works) |
| `52-attachment.png` | Attachment chip before sending |
| `53-image-sent.png` | **Raw Buffer TypeError toast + note** after sending with an image (`ATT‑01`) |
| `54-dark-session.png` | Dark theme: contrast failures, invisible meter, gaps (`DARK‑01`/`DARK‑02`) |
| `55-sse-disconnected.png` | Server killed: UI unchanged, no disconnect indicator (`SRV‑05`) |
| `56-boot-error.png` | API unreachable: BootScreen with "Failed to fetch" (`SRV‑08`) |
