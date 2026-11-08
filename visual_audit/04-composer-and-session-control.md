# 04 — Composer & session control

### ATT‑01 · Critical · Sending a prompt with an image fails with a raw Node error and loses the message
**Location:** client `lib/store.ts` / `features/Composer.tsx` send `{ mimeType, dataBase64, name }`;
`packages/pi-adapter/src/host/main.ts:535` maps `images.map(im => ({ type:"image", data: im.data,
mimeType: im.mimeType }))` — `im.data` is `undefined`.
**Repro:** attach `tiny.png` (＋ ▸ Image), type "What is in this image?", press Enter.
**Actual:** toast + persistent composer notice
`The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an
Array-like Object. Received undefined`; the message never reaches pi (nothing in the session file,
no user bubble) and the typed text is discarded because the composer clears on submit.
**Expected:** the image is delivered, or the failure is explained ("Attachments are not supported by
this pi version") **and** the draft text survives so it can be resent.
**Fix:** map `dataBase64 → data` (accept both) at the adapter boundary; keep the composer draft on
failure; translate transport errors to user copy.
**Evidence:** `52-attachment.png`, `53-image-sent.png`

### CTL‑01 · Medium · Oversized-attachment error copy is developer-facing
"big.png is too large (max 5 MB encoded)" — the word "encoded" is meaningless to users; the limit
should be phrased as file size ("over ~3.7 MB file limit") and the check should use the *file* size
(the code compares base64 length against `MAX_IMAGE_BYTES`).

### CTL‑02 · High · Model & command catalogues are fetched once, before the runtime exists
**Location:** `store.openSession()` fetches `/models` and `/commands` immediately; nothing re-fetches
them when the managed pi becomes controllable (`ownerChanged` only re-fetches status).
**Repro:** sidebar ▸ New Session (or hero send), open the composer's model chip.
**Actual:** "No model catalogue (no owning runtime)"; the ＋ menu has no slash commands
(`GET …/commands` returned `{"commands":[]}` at that moment, `…/models` 501).
Navigating away and back makes both appear — so the data exists, the client is just stale.
**Expected:** catalogue appears as soon as the runtime is ready (retry on `ownerChanged` /
`capabilities.modelsCatalog`, or lazily when the menu is opened).
**Fix:** fetch models/commands lazily on menu open + on `ownerChanged`/`runtimeState` when empty.
**Evidence:** `26-model-menu.png`, `28-add-menu.png`

### CTL‑03 · High · After a model change the UI keeps showing (and ticking) the old model
**Repro:** open the model menu in a live session ▸ pick "Mock Echo 2".
**Actual:** the request succeeds (`lastOperation.state = succeeded`) and
`GET /sessions/:key` reports `runtime.model = mock/mock-echo-2`, but the composer chip still reads
`mock/mock-echo`, the menu still ticks "Mock Echo" (`aria-selected=true` on the old row), and the
Session panel still says `Mock Echo`. Only a full reload shows the truth.
**Expected:** chip, menu tick and Session panel update within a second, or a "switching…" state.
**Fix:** refresh status (or apply the optimistic value) after `setModel`, and re-fetch models.

### CTL‑04 · Medium · Thinking-level changes are silently reverted when unsupported
**Repro:** model "Mock Echo 2" (reasoning: false) → thinking menu ▸ high.
**Actual:** the level goes back to `off` with no toast, note or disabled control; the menu still
looks enabled.
**Fix:** disable/annotate the thinking control when the selected model has `reasoning: false`, and
surface the rejection (`watchOperation` already sees failures, but this one "succeeds" and the
runtime silently normalises).

### CTL‑05 · Medium · Queue dock: no per-item actions, duplicate representation
Queued messages appear both in the dock and as normal bubbles in the transcript with nothing marking
them as queued or distinguishing *steer* from *follow-up*. Only a global "Clear queue" exists (and
only when the capability is exposed; with the mock runtime `clearQueue:false` so there is no way to
remove a queued item).
**Fix:** mark queued bubbles ("queued · follow-up"), add per-row remove when supported, and hide the
transcript echo or dim it until the item is consumed.

### CTL‑06 · Medium · Rename dialog opens empty for sessions that are "named" by their first prompt
**Location:** `App.tsx` `PromptDialog initial={runtime.sessionName ?? meta.name ?? ""}`.
**Repro:** open a fresh session (title shows the first prompt) → header title or `Ctrl+R`.
**Actual:** an empty field; "Save" is disabled and the user cannot see the current display title.
**Fix:** prefill with the effective title and say so ("Currently derived from your first message").

### CTL‑07 · Medium · Read-only sessions: disabled controls still look enabled
The composer card keeps a solid border and the `thinking off` / `Select model` chips render at
`opacity:.5` but still respond to hover/click (they open a menu with a single disabled item), and
the send button keeps a saturated blue fill while `disabled`. Only the placeholder text explains
("Read-only view — this session has no running pi to control", long enough to wrap on mobile).
**Fix:** a real disabled visual state (muted fill, `cursor: not-allowed`, no menu on click) and a
shorter placeholder + an inline "read-only" badge next to the composer.
**Evidence:** `02-markdown-top.png`, `54-dark-session.png`

### CTL‑08 · Low · Steer/Follow-up affordance states are ambiguous
When busy, `Follow-up` is active by default but `Steer` looks like a normal button; there is no hint
what either does until you hover. Add a one-line explanation ("Send now and interrupt" vs "Send
after this turn") or a tooltip, and reflect the choice in the placeholder (already done) plus in the
queued bubble (see CTL‑05).

### CTL‑09 · Medium · Composer auto-grow height goes stale
`useEffect` keyed on `[text]` only: after a resize (or a session switch where `text` stays `""`)
the textarea kept `height: 336px` (the 336 px cap) with an empty value, consuming 402 px of an
844 px phone viewport. A reload fixed it.
**Fix:** recompute on resize and on session change; also reset `height:auto` before measuring.
**Evidence:** `46-mobile-hero-clean.png`

### CTL‑10 · Low · Runtime notes are easy to miss and can overlap content
`v.notes[last]` shows only the most recent note inside the composer top edge, partially over the
transcript (see the note covering the "stopped" chip in `53-image-sent.png`); older notes are
dropped silently and the note disappears after 8 s with no way to re-read it. Prefer a stack of
dismissible notices, or a persistent banner above the composer for capability notes.

### CTL‑11 · Low · "Return to terminal" / "Compact" appear in the ＋ menu with no target feedback
Both commands fire immediately from a menu item with no confirmation and no visible progress;
"Return to terminal" in particular stops the run. Give each a confirmation or an undo toast.

### CTL‑12 · Medium · `Ctrl+R` hijacks the browser reload
`App.tsx` binds `Ctrl/Cmd+R` to rename and calls `preventDefault()`, so the standard reload
shortcut stops working inside the app (and it is undocumented in Settings ▸ Keyboard).
**Fix:** use `Ctrl+Shift+R`/`F2`, or don't intercept the browser's reload.
