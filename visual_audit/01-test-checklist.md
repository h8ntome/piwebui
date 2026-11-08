# 01 — Test checklist (coverage)

Legend: ✅ tested and OK · ⚠️ tested, issue found (ID links into the area file) · ❌ blocked/not reached

## Pages / top-level states

| Surface | 1440×900 | 820×1180 | 390×844 | Result |
|---|---|---|---|---|
| Boot: connecting screen | ✅ | ✅ | ✅ | ⚠️ `GEN‑01` (spinner only, no version/server hint) |
| Boot: server unreachable (API aborted) | ✅ | – | – | ✅ retries every 3 s, recovers automatically · ⚠️ `SRV‑05` raw `Failed to fetch` |
| Hero (no session) | ✅ | ✅ | ✅ | ⚠️ `GEN‑02`, `HERO‑01..03` |
| Hero (new session, workspace chosen) | ✅ | ✅ | ✅ | ⚠️ `HERO‑02` dashed "nothing selected" border |
| Read-only session (history/mirror) | ✅ | ✅ | ✅ | ⚠️ `CTL‑07`, `MD‑*` |
| Live managed session (mock provider) | ✅ | ✅ | ✅ | ⚠️ `CTL‑01..05` |
| Empty session (0 entries) | ✅ | ✅ | ✅ | ⚠️ `GEN‑04` (falls back to hero, no "this session is empty" state) |
| Sidebar: grouped / flat / search / empty | ✅ | ✅ (rail) | drawer | ⚠️ `SB‑01..09` |
| Right panel: Session / Files / Trajectory / Context | ✅ | – | ⚠️ `MOB‑01` | ⚠️ `PNL‑01..07`, `TRJ‑01` |
| Settings dialog (5 tabs, all controls) | ✅ | – | – | ⚠️ `SET‑01..07` |
| Directory picker (browse/edit/hidden/pick) | ✅ | – | – | ⚠️ `WS‑02..05` |
| Rename prompt | ✅ | – | – | ⚠️ `CTL‑06` |
| Toasts | ✅ | ✅ | ✅ | ⚠️ `SET‑07`, `CTL‑01` |
| 400-entry session | ✅ | – | ✅ | ❌ older 100 entries unreachable `TRN‑01` |

## Interactions exercised

Sidebar: New Session · workspace row menu (New session here / Open files panel / Copy path / Remove
from allowlist) · session row menu · copy session path · search open/type/clear/escape/close · View
options (both groups) · More menu (all items) · collapse/expand rail · brand click · add workspace.

Main column: breadcrumb rename · header panel toggles (3) · context trigger + popover · hero
workspace chip menu · session switching by click and by Alt+↑/↓ · scroll/pinning · "Jump to
latest" (not observed as needed) · jump-to-entry from Trajectory (works for loaded, errors for
unloaded).

Composer: type/Enter/Shift+Enter · empty send (disabled) · send with workspace not chosen ·
model menu (open, select, stale selection) · thinking menu (open, select, silent revert) · Add
menu (Image / Compact / Return to terminal) · image attach (valid, >5 MB, send) · Steer /
Follow-up pills · queue (2 items) · queue dock expand/collapse · Stop button · Ctrl+. abort ·
disabled read-only state · auto-grow behaviour.

Right panel: all four tabs · tab switching from header icons · file tree navigation (dirs, file,
binary detection via API, >2 MB `too_large`, unicode names) · file copy/close · tree reload ·
context reload · "Show the prompt" disclosure · download session log (raw endpoint verified via
API) · panel width change from Settings while open.

Sessions/control plane: create managed pi · prompt streaming · tool call round-trip · queueing ·
steering · abort (`Ctrl+.` and stop button) · rename (live propagation) · model switch (server
side succeeded) · thinking change · compact menu item presence · Return to terminal item
presence · remove workspace · add workspace · refresh sessions.

Settings: theme system/light/dark · content size · code size · panel width · group by workspace ·
show read-only · collapsed sidebar · show timestamps · reveal actions on hover · auto-scroll ·
Enter sends · About tab data · Reset interface settings (restores + reloads).

Edge/corrupt data: malformed JSONL line (dropped silently) · whitespace-only message · assistant
`isError` · empty content array · thinking-only message · user message with image block ·
compaction entry · model_change / thinking_level_change · CJK/emoji/RTL titles · 300-line tool
output · structured (non-array) tool result · tool call with no result · 8-column markdown table ·
long unbreakable tokens · task lists · indented code · language-less fences.

Automated probes: `agent-browser a11y` (axe-core 4.12.1) · `vitals` · `console` · `errors` ·
`network requests` · `curl` against `/api/v1/{health,meta,capabilities,sessions,workspaces,files,
sessions/:key/{entries,tree,context,stats,models,commands,raw}}` · CSSOM/DOM geometry probes for
spacing, z-index, computed colours, scroll metrics.

## Keyboard shortcuts

| Shortcut | Result |
|---|---|
| `Ctrl+B` sidebar | ✅ works |
| `Esc` menu/dialog | ✅ closes both |
| `Ctrl+,` settings | ✅ works (synthetic keydown; harness `press Control+comma` sends a different `key`) · ⚠️ not listed in Settings ▸ Keyboard `SET‑05` |
| `Ctrl+.` abort | ✅ stops the run |
| `Alt+↑/↓` session step | ✅ works, ⚠️ steps the *unfiltered* list `SB‑09` |
| `Ctrl+R` rename | ⚠️ hijacks browser reload, undocumented `SET‑05` |
| `Ctrl+N` new session | not verified in headless (browser reserves it) — see limitations |
| `Ctrl+K` focus composer | ⚠️ focuses, but the composer is `disabled` in read-only sessions and there is no visible focus ring check — see `A11Y‑04` |
| Tab order / focus-visible across the app | ❌ not systematically walked, see `11-untested-and-limitations.md` |
