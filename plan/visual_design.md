# Visual Design System

Reviewed v0.2 note: this file retains the original proposed Pi palette mappings.
Revalidate assets and contrast during implementation; no generator/audit exists yet.
Runtime/source/interaction semantics are governed by ui_design.md and api_spec.md.


Goal (G-5): a visitor should say "that's pi in a browser" within two seconds — not "that's
a nice chat app". The palette is not inspiration; it is **copied from the installed pi
theme files** ✓ and generated at build time.

---

## Source of truth

| Item | Value |
|---|---|
| Files | `…/pi-coding-agent/dist/modes/interactive/theme/{dark,light}.json` ✓ |
| Format | `vars` (reusable) + `colors` (56 terminal roles) + `export` (page/card backgrounds) ✓ |
| Colour space | `okhsl(H S L)` — **not valid CSS**; pi's own code notes this when producing HTML exports: *"Export colors end up in CSS, which understands hex and oklch() values directly but not okhsl()"* (`theme.js:690` ✓) |
| Our conversion | Build-time `okhsl → hex` (same math pi uses via `colorToHex(parseColor(…))` ✓), emitted into `tokens.css` |
| Reuse constraint | `getThemeExportColors()` exists in pi but is **not** re-exported from the package entry point ✓ → we read the JSON and convert ourselves; no deep imports into `dist/` internals (fragile across upgrades → risk R-06 (Pi adapter compatibility)) |
| Custom themes | If the user's `theme` setting names a custom `<agent-dir>/themes/<name>.json` ✓, the server reads it and regenerates tokens on demand (`GET /themes/current`). `system` (the pi default ✓) has no fixed palette → pi-web falls back to `dark`/`light` by OS preference, and states so in settings |

`tokens.css` is generated, never hand-edited. `npm run gen:palette` + a CI assertion that
the committed file matches pi's JSON.

## Palette: dark theme

Shared vars:

| pi var | value | pi role examples ✓ | pi-web use |
|---|---|---|---|
| `text` | `okhsl(234 3% 89%)` | `text`, `userMessageText`, `toolTitle` | body text, primary labels |
| `muted` | `okhsl(229 6% 67%)` | `muted`, `toolOutput`, `mdQuote`, `syntaxComment` | secondary text, tool output, timestamps |
| `dim` | `okhsl(229 8% 56%)` | `dim` | footer, rail group labels, disabled |
| `violet` | `okhsl(295 50% 67%)` | `accent`, `mdCode`, `mdListBullet`, `syntaxType`, `customMessageLabel` | accent: links, active nav, focus ring, mode chip |
| `blue` | `okhsl(232 54% 67%)` | `mdLink`, `syntaxKeyword` | links, keyword syntax |
| `green` | `okhsl(159 59% 67%)` | `success`, `mdCodeBlock`, `syntaxNumber`, `toolDiffAdded`, `bashMode` | success, added diff lines, ok tool status |
| `red` | `okhsl(20 72% 67%)` | `error`, `toolDiffRemoved` | errors, removed diff lines, abort |
| `yellow` | `okhsl(83 88% 67%)` | `warning`, `mdHeading`, `syntaxFunction` | warnings, retry, headings |
| `blueBg` | `okhsl(233 41% 24%)` | `selectedBg`, `userMessageBg` | user-message band, selection |

Surfaces (from `export` + bg roles ✓):

| Token | value | meaning in pi | pi-web use |
|---|---|---|---|
| `--pi-page-bg` | `okhsl(262 14% 16%)` | `export.pageBg` ✓ | app background |
| `--pi-card-bg` | `okhsl(264 13% 19%)` | `export.cardBg` ✓ | rail, panel, composer surface |
| `--pi-tool-pending-bg` | `okhsl(229 5% 24%)` | pending tool row ✓ | streaming tool row |
| `--pi-tool-success-bg` | `okhsl(158 46% 25%)` | ok tool row ✓ | completed tool row |
| `--pi-tool-error-bg` | `okhsl(19 54% 25%)` | failed tool row ✓ | error tool row |
| `--pi-custom-msg-bg` | `okhsl(295 42% 24%)` | extension message bg ✓ | extension entries |
| `--pi-info-bg` | `okhsl(53 51% 24%)` | `export.infoBg` ✓ | banners/notes |
| `--pi-search-bg` | `okhsl(53 51% 24%)` | search hit ✓ | find highlights |
| `--pi-border` | `okhsl(231 57% 65%)` | `border` ✓ | active/focus borders |
| `--pi-border-accent` | `okhsl(295 53% 64%)` | `borderAccent` ✓ | focus ring, active tab |
| `--pi-border-muted` | `okhsl(229 8% 53%)` | `borderMuted` ✓ | hairlines, inactive borders |
| `--pi-scrollbar-thumb/track` | `okhsl(232 7% 65%)` / `okhsl(237 7% 33%)` | scrollbars ✓ | styled scrollbars |

Thinking-level tints — used to colour the thinking label and the level chip ✓:

| level | dark | level | dark |
|---|---|---|---|
| `off` | `okhsl(229 8% 49%)` | `high` | `okhsl(295 73% 59%)` |
| `minimal` | `okhsl(232 20% 52%)` | `xhigh` | `okhsl(337 81% 61%)` |
| `low` | `okhsl(232 45% 54%)` | `max` | `okhsl(20 99% 63%)` |
| `medium` | `okhsl(263 59% 56%)` | `thinkingText` | `okhsl(226 7% 65%)` |

Syntax roles ✓ (`syntaxKeyword/String/Number/Type/Function/Variable/Comment/Operator/Punctuation`)
map 1:1 onto the code highlighter theme so pi-web's code blocks match pi's TUI and match
pi's own HTML export.

## Palette: light theme

| var | value | | var | value |
|---|---|---|---|---|
| `text` | `okhsl(225 5% 27%)` | | `green` | `okhsl(159 75% 46%)` |
| `muted` | `okhsl(229 8% 47%)` | | `red` | `okhsl(20 91% 47%)` |
| `violet` | `okhsl(295 60% 46%)` | | `yellow` | `okhsl(83 99% 47%)` |
| `blue` | `okhsl(231 68% 47%)` | | `blueBg` | `okhsl(235 19% 91%)` |
| `pageBg` | `okhsl(17 3% 94%)` ✓ | | `cardBg` | `okhsl(17 5% 97%)` ✓ |
| `infoBg` | `okhsl(56 22% 91%)` ✓ | | | |

Light mode is generated from the same roles, not designed separately — that is what keeps
the two appearances coherent and halves the maintenance cost.

## Theming pipeline

```
pi theme JSON (dark/light/custom)  →  resolve var refs ✓
                                   →  okhsl → hex
                                   →  tokens.css  ( :root[data-pi-theme=dark] / [light] )
                                   →  Tailwind theme / CSS vars consumed by components
```

| Rule | Detail |
|---|---|
| Appearance mode | `auto` (default, follows `prefers-color-scheme`), `dark`, `light` — mirrors pi's own `theme: "light/dark"` auto pairing ✓ |
| Where stored | `localStorage` on the browser; a `?theme=` URL param overrides for screenshots |
| Flash prevention | Same-origin blocking external script (or CSP nonce/hash) sets `data-pi-theme` before first paint; no unallowed inline script |
| Custom pi theme | `GET /themes/current` returns converted tokens for the user's active pi theme ✓; settings shows which file it came from |
| No hardcoded colours | Zero hex literals in components; ESLint rule forbids `#[0-9a-f]{3,8}` in `client/src` |

## Typography

| Token | Value | Use |
|---|---|---|
| `--font-ui` | system stack: `-apple-system, "SF Pro Text", Inter, Segoe UI, Roboto, sans-serif` | chrome, rail, buttons, labels |
| `--font-mono` | `"SF Mono", "JetBrains Mono", Menlo, Cascadia Code, ui-monospace` | **transcript body**, code, tool output, paths, entry ids |
| Base | `16 px` / `line-height 1.65` | transcript measure `72 ch` (min `60`, max `88`) |
| Scale | `13 / 14 / 16 / 18 / 22` px, ratio ≈ 1.2 | 13 chrome · 14 meta/timestamps · 16 body · 18 h2 · 22 h1/empty-state |
| Weights | `400` body · `500` UI labels · `600` headings only | no `700+`: heavy weight reads as marketing |
| Tabular numerals | `font-variant-numeric: tabular-nums` on token counts, durations, costs, timestamps | columns align |

**Decision:** the transcript itself is **monospace**. Rationale: pi's transcript is a
terminal document with aligned borders, code, and tool output; proportional body text
against monospace code blocks is the single fastest way to make a pi session look like a
generic chat app. Proportional type is reserved for chrome. (This is the opposite of
DeepSeek/ChatGPT defaults and is deliberate.) Markdown headings inside assistant text use
`--font-ui` at `18/22 px` so structure still reads.

## Space, shape, borders

| Token | Value | Notes |
|---|---|---|
| `--s-1…--s-6` | `4 / 8 / 12 / 16 / 24 / 32` px | 4 px grid; only these |
| `--row-pad-y` | `6 px` | transcript rows; density is a feature (P-4) |
| `--block-gap` | `20 px` | between entries |
| `--radius` | `3 px` (chips `2 px`, modals `6 px`) | large radii = chat app |
| `--border` | `1 px solid var(--pi-border-muted)` | hairlines everywhere |
| `--border-strong` | `1 px solid var(--pi-border)` | tool rows, composer |
| `--focus-ring` | `2 px solid var(--pi-border-accent)`, offset `2 px` | never colour-only for state |
| Elevation | **none** — no `box-shadow` anywhere | Depth comes from bg-step + hairline only; `--pi-page-bg` vs `--pi-card-bg` is the entire elevation system |
| Icons | `lucide`, `1.5 px` stroke, `16 px` inline / `20 px` buttons | line icons match hairlines |

## Component-level specs

| Component | Spec |
|---|---|
| Mode chip (history/mirror/live/managed) | mono `12 px`, uppercase `0.04 em`, bg `--pi-tool-pending-bg`, border `--pi-border-muted`; `live` / `managed` add a `--pi-border-accent` left border `2 px`; `mirror` uses `blue`; `diverged` uses `red` bg `--pi-tool-error-bg` |
| Tool row | radius `3`, border `--pi-border-muted`, bg `pending → success → error` per state ✓, `padding 6 10`, left icon `16 px`, duration right-aligned tabular `12 px --pi-dim` |
| Diff line | `--pi-diff-added` / `--pi-diff-removed` / `--pi-diff-context` ✓ on `+ − ` gutter; 2 px left accent bar; no background flood |
| Thinking block | label tinted by level token ✓; content `--pi-thinking-text` ✓, italic off (thinking is text, not annotation) |
| Context meter | 5-segment block using `▓░` characters (pi's footer uses the same idiom ✓), `> 80 %` `--pi-yellow`, `> 95 %` `--pi-red` |
| Buttons | bg transparent, border `--pi-border-muted`, `padding 6 12`, hover bg `--pi-tool-pending-bg`; **primary** = bg `--pi-card-bg` + border `--pi-border-accent` (never a filled saturated button) |
| Composer | bg `--pi-card-bg`, `1 px` border → `--pi-border-accent` when focused, radius `6`, textarea transparent, status row separated by a hairline |
| User band | full-bleed `--pi-user-msg-bg` with `--pi-text` ✓; no rounded bubble, no avatar |
| Banner | `--pi-info-bg` for notes ✓, `--pi-tool-error-bg` for failures; 1 px border, no icon animation |
| Scrollbar | styled with `--pi-scrollbar-*` ✓, width `10 px` |
| Selection | `background: var(--pi-selected-bg)` ✓ (`blueBg`) |
| Toasts | top-right stack, max 3, `--pi-card-bg`, no auto-dismiss for errors (only for extension `notify` ✓) |

## "Looks like pi" checklist

A reviewer should be able to tick all of these on a screenshot:

- [ ] Transcript is monospace; chrome is system-sans
- [ ] No avatar, no bubble, no shadow, no gradient, no illustration
- [ ] User messages are a full-width `blueBg` band, exactly like pi's TUI
- [ ] Tool calls are bordered single-line rows with duration, expandable
- [ ] Thinking label colour encodes thinking level ✓
- [ ] Model/thinking changes appear as hairline inline rules
- [ ] Compaction appears as a labelled boundary block, originals still present
- [ ] Footer carries cwd · branch · versions · connection, like pi's status line
- [ ] Context usage is a `▓░` block meter
- [ ] Accent is violet, not blue (`accent: violet` ✓ in both pi themes)
- [ ] Error `red`, warning `yellow`, success `green` from the theme, never browser defaults
- [ ] Link colour `--pi-blue` with `mdLinkUrl` style muted URL text ✓
- [ ] Light and dark both derived from pi JSON, both pass the contrast table below

## Contrast audit

Targets: body ≥ 7:1, chrome/secondary and thinking labels ≥ 4.5:1 (pi's own `system` theme guarantees ≥ 4.5:1
for body text ✓; we hold body higher as a deliberate readability target, subject to measured contrast).

| Pair | Target | Verification |
|---|---|---|
| `text` on `pageBg` | ≥ 7:1 | `scripts/contrast-audit.ts` computes from generated hex; CI fails on regression |
| `muted` on `pageBg` | ≥ 4.5:1 | same |
| `dim` on `pageBg` | ≥ 4.5:1 — **known risk**: `dim` is the lowest-chroma colour in pi's dark set; fails → bump lightness by the minimum that passes and record the deviation from pi's values |
| `text` on `userMessageBg` (`blueBg`) | ≥ 7:1 | same |
| `success/error/warning` on their tool-row bgs | ≥ 4.5:1 | same |
| Thinking level text colours on `pageBg` | ≥ 4.5:1 (these labels are text) | same |
| Focus ring vs both backgrounds | ≥ 3:1 | same |

The audit script is a *test*, not a manual check, so a pi theme change can never silently
degrade readability. Any colour pi uses that fails our bar gets a documented `-piweb-adj`
token (one place, listed here) rather than an inline override.

## Motion

| Aspect | Spec |
|---|---|
| Durations | `120 ms` micro (hover, chip), `180 ms` region (rail collapse, panel drawer), nothing longer |
| Easing | `cubic-bezier(0.2, 0, 0, 1)` for all |
| Allowed | opacity, transform, height for one-line collapses |
| Streaming | tokens appear with **no** per-token animation; block-level fade-in only for `message_end` |
| Forbidden | spinners that spin for their own sake (the streaming indicator is a text caret + elapsed clock), parallax, bouncing, pulsing avatars, typing dots |
| `prefers-reduced-motion` | all transitions `0 ms`; auto-scroll becomes instant |

## Iconography & copy tone

Icons only where a word would be wider (live/mirror, expand, copy, rename, delete,
settings, workspace). Every icon button has a visible text alternative somewhere (tooltip
is not an alternative — see accessibility requirements in [ui_design.md](ui_design.md#accessibility)).

Copy is lowercase-ish, plain, and specific: "Take control", "Continue in terminal",
"3 tool calls, 12 s", "pi is still running", "Saved to the session 400 ms
ago". No exclamation marks, no apologetic hedging, no "Oops!". Error copy always names the
**cause** and the **next action** ([reliability.md](reliability.md#failure-behaviour)).
