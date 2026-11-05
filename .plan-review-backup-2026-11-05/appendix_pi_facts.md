# Appendix — Verified pi Facts

Every ✓ mark in this plan traces to a row here. Nothing in this file is design; it is
evidence, captured on 2026-11-05 against the installation below, and each claim is
mechanically re-checkable.

| | |
|---|---|
| pi package | `@earendil-works/pi-coding-agent` **1.5.0** |
| Path | `/Users/hadi/.local/lib/node_modules/@earendil-works/pi-coding-agent` |
| `engines` | `node >= 22.19.0` |
| Local runtime | Node v26.12.1, npm 11.20.0 (Bun 1.3.11 and pnpm 9.15.4 also present) |
| pi CLI | `pi --version` → `1.5.0` |
| Key deps seen | `proper-lockfile@4.1.2`, `typebox@1.3.27`, `undici@8.12.3` |
| Docs root | `…/pi-coding-agent/docs/` (`cli-integration.md`, `rpc.md`, `rpc-commands.md`, `json.md`, `sdk.md`, `sessions.md`, `session-format.md`, `message-types.md`, `themes.md`, `security.md`, `compaction.md`) |

## Re-verification

`scripts/verify-pi.ts` (P0 deliverable) asserts all of the following and fails CI on
drift. Manual equivalents:

```bash
PI=/Users/hadi/.local/lib/node_modules/@earendil-works/pi-coding-agent
pi --version
cat $PI/package.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['version'], d['engines'])"
# session entry + manager types
grep -n "interface Session\|type SessionEntry\|static \(create\|open\|continueRecent\|list\|listAll\|findById\|forkFrom\)" \
    $PI/dist/core/session-manager.d.ts
# no locking on session files (expect only auth/settings/trust to use proper-lockfile)
grep -rln "proper-lockfile" $PI/dist --include=*.js
grep -n "appendFileSync\|writeFileSync\|lock" $PI/dist/core/session-manager.js
# leaf derivation on open
grep -n -A6 "_buildIndex()" $PI/dist/core/session-manager.js | head
# public exports available to pi-web
grep -n "createAgentSession\|SessionManager\|RpcClient\|buildSessionContext\|getThemeExportColors" \
    $PI/dist/index.d.ts $PI/dist/modes/interactive/theme/theme.d.ts
# RPC command + event surface
grep -n "^### \|^## " $PI/docs/rpc-commands.md
grep -n "^| \`" $PI/docs/json.md
# palette
python3 -c "import json;print(json.load(open('$PI/dist/modes/interactive/theme/dark.json')))"
```

## Session storage facts

| Fact | Source |
|---|---|
| JSONL, one object per line, `type` discriminator, tree via `id`/`parentId` | `docs/session-format.md` |
| Path: `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`; `<path>` = leading separator dropped, `/ \ :` → `-` | `docs/session-format.md` |
| Current session **version 3**; v1 linear and v2 tree auto-migrate on load; v3 renamed `hookMessage` → `custom` | `docs/session-format.md` |
| Header line: `{"type":"session","version":3,"id","timestamp","cwd"[,"parentSession"]}`; metadata only, not in the tree | same |
| Default dir overridable by `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, `sessionDir` setting (CLI wins) | `docs/sessions.md` |
| Deleting a session = deleting its file; `/resume` `Ctrl+D` + confirm; uses `trash` CLI when available | `docs/session-format.md`, `docs/sessions.md` |
| A session leaves **no file** until it has a user or assistant message | `dist/core/session-manager.js` `_hasConversation()` + comment above `_persist` |
| Persistence: `appendFileSync(sessionFile, JSON.stringify(entry)+"\n")`; first flush writes the whole file with `openSync(…, "wx")` | `dist/core/session-manager.js` |
| **No lock** around session writes; `proper-lockfile` is used only by `auth-storage.js`, `settings-manager.js`, `trust-manager.js`, `package-manager-cli.js`, `extensions/mcp/oauth.js` | grep of `dist` |
| On open, `_buildIndex()` sets `leafId` to the **last** entry in file order | `dist/core/session-manager.js` |
| Context build: `buildContextEntries()` (leaf→root, honours latest `compaction` + `firstKeptEntryId`) → `buildSessionProjection()` (applies latest `context_edit` per target) → `buildSessionContext()` (entries→messages, extracts model + thinking level) | `docs/session-format.md`, exported in `dist/index.d.ts` |
| System messages persist prompt **sections** + `toolsAdded`/`toolsRemoved`; replaying in order reconstructs current prompt/tools; "no separate prompt state entry" | `docs/session-format.md` |
| `pi --continue` uses the current dir; `--resume`/`--session`/`/import` use the session's own cwd; `--fork` re-roots in the current dir | `docs/sessions.md`, `docs/cli.md` |
| Startup flags relevant to pi-web: `--session`, `--session-id`, `--session-dir`, `--fork`, `--name/-n`, `--no-session`, `--mode rpc`, `--model`, `--thinking`, `--approve`/`--no-approve` | `docs/cli.md` |

### Session entry types (11 + header)

| `type` | In LLM context | Notable fields ✓ |
|---|---|---|
| `session` (header) | no | `version`, `id`, `timestamp`, `cwd`, `parentSession?` |
| `message` | yes | `message: AgentMessage` (roles `system\|user\|assistant\|toolResult` + extended); assistant carries `api`, `provider`, `model`, `usage`, `stopReason`, `thinkingLevel?` |
| `model_change` | selection state | `provider`, `modelId` (may be a virtual model) |
| `thinking_level_change` | selection state | `thinkingLevel` |
| `usage` | no (totals only) | `kind` (arbitrary string, e.g. `cache_warm`), `provider`, `model`, `usage` |
| `compaction` | replaces older | `summary`, `firstKeptEntryId` (required), `tokensBefore`, optional `systemMessage`, `usage`, `details`, `fromHook` |
| `context_edit` | modifies a target | `targetId`, `replacement` (`null` = omit); latest edit on the active branch wins; branch-relative |
| `branch_summary` | yes | `fromId`, `summary`, optional `usage`, `details`, `fromHook` |
| `custom` | no | `customType`, `data` (e.g. `pi.virtual-model-state`) |
| `custom_message` | yes | `customType`, `content`, `display` |
| `label` | no | `targetId`, `label` (`undefined` clears) |
| `session_info` | no | `name` (shown in `/resume` picker) |

`SessionManager` static API observed: `create`, `open`, `continueRecent`, `inMemory`,
`forkFrom`, `findById`, `list`, `listAll`. `SessionInfo` fields: `path, id, cwd, name?,
parentSession?, created, modified, messageCount, firstMessage, allMessagesText`.

## Modes available to a host

| Mode | Command | Notes |
|---|---|---|
| print | `pi --print "…"` | final text only, exits |
| json | `pi --mode json "…"` | header + events, exits after the run |
| **rpc** | `pi --mode rpc [--session …]` | long-lived JSONL commands/responses/events ✓ |
| **SDK** | `createAgentSession()`, `createAgentSessionServices`, `createAgentSessionFromServices`, `createAgentSessionRuntime` | in-process; `AgentSessionRuntime` adds `newSession/switchSession/fork/importFromJsonl` ✓ |
| `RpcClient` | exported class | spawns and drives an RPC child ✓ |

Framing rules that pi-web must honour: one JSON object per line terminated by **LF only**;
do **not** use Node `readline` (it splits on `U+2028`/`U+2029`); stdout is protocol-only,
stderr is diagnostics; read continuously or you stall pi ✓.

## RPC command surface (usable by pi-web)

`prompt` (`streamingBehavior: steer|followUp`, `images`, `disposition: started|queued|handled`) ·
`steer` · `follow_up` · `abort` (waits idle) · `clear_queue` (returns queued text) ·
`new_session` (`parentSession`, `cancelled`) · `get_state` (model, thinkingLevel,
isStreaming, isCompacting, steeringMode, followUpMode, sessionFile/Id/Name,
autoCompactionEnabled, messageCount, pendingMessageCount) · `get_messages` ·
`set_model` · `cycle_model` · `get_available_models` · `set_thinking_level`
(`off…max`) · `cycle_thinking_level` · `get_available_thinking_levels` ·
`set_steering_mode` · `set_follow_up_mode` · `compact` (`summary`, `firstKeptEntryId`,
`tokensBefore`, `estimatedTokensAfter`, `usage`) · `set_auto_compaction` · `set_auto_retry` ·
`abort_retry` · `bash` / `abort_bash` (**deliberately not exposed by pi-web**) ·
`get_session_stats` (counts, tokens, `cost`, `contextUsage` — `null` right after compaction) ·
`export_html` · `switch_session` (`cancelled`) · `fork` (`text`, `cancelled`) · `clone` ·
`get_fork_messages` · `get_entries` (`since`, returns `entries` + `leafId`) ·
`get_tree` (roots may be multiple; nodes `{entry, children, label?, labelTimestamp?}`) ·
`get_last_assistant_text` · `set_session_name` · `get_commands`
(`source: extension|prompt|skill`, `sourceInfo{path,source,scope,origin,baseDir}`; built-in
TUI commands excluded).

Extension UI subprotocol ✓: blocking dialogs `select`, `confirm`, `input`, `editor`
(`extension_ui_request` → `extension_ui_response`, `timeout` auto-resolves server-side);
fire-and-forget `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.
TUI-only methods are no-ops/unsupported in RPC mode (`custom()`, `setTheme()`, etc. ✓) —
which is exactly why pi-web adds no TUI-shaped features.

## Session-event surface (JSON/RPC) ✓

`agent_start` · `agent_end` (`messages`, `willRetry`) · `agent_settled` (`aborted`) ·
`turn_start` · `turn_end` · `message_start` · `message_update` (`usage` +
`assistantMessageEvent`) · `message_end` · `tool_execution_start` · `tool_execution_update`
(`partialResult`) · `tool_execution_end` (`isError`, `durationMs`) · `queue_update`
(`steering`, `followUp`) · `entry_appended` · `session_info_changed` ·
`thinking_level_changed` · `compaction_start` (`reason: manual|threshold|overflow`) ·
`compaction_end` (`result` \| `aborted` \| `errorMessage` \| `willRetry`) ·
`auto_retry_start` · `auto_retry_end` · `summarization_retry_scheduled` ·
`summarization_retry_attempt_start` · `summarization_retry_finished` ·
RPC-only: `bash_execution_update`, `extension_error`.

`assistantMessageEvent` types ✓: `start`, `text_start`, `text_delta`, `text_end`,
`thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_start` (`id`, `toolName`),
`toolcall_delta`, `toolcall_end` (`toolCall`), `done`, `error`.

Rule relied on throughout: JSON/RPC wire records are delta-only (cumulative `message` and
`partial` are stripped) and `message_end` is authoritative ✓.

## Message model ✓

Content blocks: `TextContent{text, textSignature?}`, `ImageContent{data, mimeType}`
(base64), `ThinkingContent{thinking, thinkingSignature?, redacted?}`,
`ToolCall{type,id,name,arguments,thoughtSignature?,namespace?}`.
`Usage{input,output,cacheRead,cacheWrite,cacheWrite1h?,reasoning?,totalTokens,cost{…}}`
— `reasoning` already included in `output`. Roles: `system` (`sections`,
`toolsAdded`, `toolsRemoved`), `user`, `assistant`, `toolResult`
(`toolCallId`, `toolName`, `content`, `isError`), plus coding-agent extensions
(`CustomMessage`, `BashExecutionMessage`). Timestamps: entry = ISO 8601, message = Unix ms.

## Palette source of truth ✓

`dist/modes/interactive/theme/dark.json` / `light.json` / `system-theme.js`, schema
`schemas/theme.schema.json`, user themes at `~/.pi/agent/themes/<name>.json`, setting
`theme` (`"dark"`, `"light"`, `"light/dark"`), default `system`.

- dark vars / light vars, dark role dump (56 roles) and the `export` block:
  reproduced verbatim in [visual_design.md](visual_design.md#palette-dark-theme).
- `okhsl()` is **not** valid CSS; pi's own comment says export colours become hex or
  `oklch()` for CSS (`theme.js:690` ✓).
- `getThemeExportColors(themeName?)` exists in `theme.js`/`theme.d.ts` but is **not**
  re-exported from the package entry point ✓ → pi-web converts the JSON itself rather than
  deep-importing internals.
- `system` (pi's default) derives colours from the terminal and has no fixed values ✓ →
  pi-web falls back to the built-in dark/light pairing and says so.

## Capability probe

The P0 probe (`drivers/pi-probe.ts`) must confirm, and CI must assert:

| Capability key | Check | Used by |
|---|---|---|
| `session.format.v3` | `CURRENT_SESSION_VERSION === 3` ✓ | all reads |
| `session.entries.since_cursor` | `get_entries` accepts `since` ✓ | SSE resume |
| `session.tree` | `get_tree` responds ✓ | P5 tree |
| `session.lazy_create` | unprompted session writes no file ✓ | rail "not yet on disk" |
| `event.agent_settled` | event name present in exported types ✓ | run-state reset |
| `event.context_edit` | `ContextEditEntry` exported ✓ | badges |
| `event.usage_entry` | `UsageEntry` exported ✓ | totals |
| `event.compaction_reasons` | `manual\|threshold\|overflow` ✓ | narration |
| `cmd.get_commands` | responds ✓ | composer autocomplete |
| `cmd.session_stats.context_usage` | `contextUsage` present ✓ | meter |
| `cmd.extension_ui.dialogs` | `extension_ui_request` shape ✓ | P5 dialogs |
| `sdk.createAgentSession` | importable from the package entry ✓ | default driver |
| `sdk.buildSessionContext` | importable ✓ (public export) | `/context` endpoint |
| `rpc.mode_available` | `pi --mode rpc` starts | fallback driver |

Missing capability → the dependent endpoint answers `501 unsupported_capability` and the UI
hides the control; a mismatched pi **version** with all capabilities present → warning only.

## pi-web synthesized events

pi-web invents very little; where it must, it is listed here and labelled in the payload
(`synthetic: true`):

| Event | Why |
|---|---|
| `model_changed` | `set_model` has a response but no dedicated stream event ✓, so the host emits one for other clients/tabs |
| `mode_changed` | pi-web lease state, not pi state |
| `lease_state`, `divergence_detected` | pi-web's own ownership layer (no pi equivalent — F-2) |
| `snapshot`, `resync`, `stream_end`, `host_exited`, `pi_version_warning` | transport/lifecycle |

Everything else on the wire uses pi's own event name and payload so the mapping stays
auditable against `docs/json.md`.

## Terminology borrowed from pi docs (used with pi's meaning)

`session`, `entry`, `leaf`, `branch`, `active branch`, `context`, `compaction`,
`firstKeptEntryId`, `context edit`, `steering`, `follow-up`, `settled`, `disposition`,
`workspace` (ours: allowlisted cwd), `mirror` (ours), `attach` (ours), `lease` (ours).

## Known gaps / not verified

| Item | Status |
|---|---|
| Whether pi will ever add a session-file lock | unknown; backlog item to contribute one upstream (R-01) |
| Behaviour of a **torn/partial** final line under concurrent writers | assumed handled by re-read on next change; tested as a fixture (corrupt last line) rather than assumed in the design |
| `--session-id` collision semantics across dirs | not exercised; P3 test |
| Cross-machine shared filesystem (NFS) for the sessions dir | out of scope v1; the `proper-lockfile` note in [session_management.md](session_management.md#lease-design) is the only concession |
| pi 1.6+ behaviour | unknowable; handled by R-02 + capability gating |
| Windows lockfile EPERM characteristics for *our* files | inherited caution from pi's own comments ✓, scheduled P6 |
