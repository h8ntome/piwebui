# Appendix: inspected Pi facts and verification limits

Inspected on 2026-11-05. Owning package:
`/Users/hadi/.local/lib/node_modules/@earendil-works/pi-coding-agent`, version 1.5.0.
Its package declares Node >=22.19.0; local runtime is Node v26.12.1/npm 11.20.0.
These are source/type inspections and the explicitly stated local experiment, **not**
end-to-end validation of a working pi-web implementation.

## Checked facts

| Fact | Installed owning source |
|---|---|
| Public exports include createAgentSession, runtime factories, SessionManager, parseSessionEntries, migrateSessionEntries, buildContextEntries, buildSessionProjection, buildSessionContext | `dist/index.d.ts:20–21` |
| Normal persistence uses appendFileSync after initial lazy flush | `dist/core/session-manager.js:788–813` |
| No session locking appears in this manager path; do not confuse proper-lockfile dependency with session lock ownership | manager persistence and package dependency list |
| Opening an empty existing file initializes/rewrites it; opening an old session can migrate/rewrite it | `session-manager.js:665–679`, `718–725` |
| `_rewriteFile` opens with `w`, then writes records | `session-manager.js:755–767` |
| `_buildIndex` sets leaf to each encountered entry; last on disk wins on open | `session-manager.js:733–753` |
| `branch(id)` changes an in-memory leaf without appending | `session-manager.js:1173–1177` |
| Initial file flush is lazy until user/assistant content exists | `session-manager.js:784–813` |
| SessionInfo has cwd/id/path; cwd can be empty for old files, parentSessionPath is a separate field | `dist/core/session-manager.d.ts:164–178` |
| `buildSessionContext` returns messages, thinkingLevel and model, not a complete dynamic provider request | `session-manager.d.ts:155–163`, function declaration at 209 |
| Normal extension context has readonly session manager, idle/pending state, abort, compact, getContextUsage and getSystemPrompt | `dist/core/extensions/types.d.ts:232–276` |
| Extension API offers sendUserMessage with delivery modes and optional command/template expansion; it returns void | `extensions/types.d.ts:1285–1293` |
| Extension API model/name/thinking setters and commands/settings/tool introspection exist | `extensions/types.d.ts:1297–1328` |
| New/fork/navigateTree/switch/reload belong to extended command context, not ordinary ExtensionContext | `extensions/types.d.ts:300–342` |
| Extension message updates expose cumulative message plus assistantMessageEvent | `extensions/types.d.ts:861–865` |
| TurnEndEvent includes messageEntryId/toolResultEntryIds; earlier streaming IDs still require adapter correlation proof | `extensions/types.d.ts:844–852` |
| `ui_prompt_start/end` report kind/title; no response handle/options in those event interfaces | `extensions/types.d.ts:825–841` |
| SDK bindExtensions accepts uiContext, mode and command actions; prompt returns Promise<void> | `dist/core/agent-session.d.ts:168–176`, `558`, `779` |
| dispose requests cancellations/abort then invalidates contexts/disconnects listeners; not a wait-for-child-exit contract | `dist/core/agent-session.js:1024–1037` |
| Session/model context has additional routing/transformation before provider use | `agent-session.js:261`, `631`, `1364–1386`; do not claim pure persisted projection is exact provider payload |
| Built-in bash tool onUpdate sends current output.snapshot content | `dist/core/tools/bash.js:181–193`; replace snapshots rather than append |
| Pi ships typebox 1.3.27; that alone does not prove any chosen Fastify TypeBox adapter compatibility | installed package.json |
| Pi package exports only root and rpc-entry subpath; do not import arbitrary dist implementation modules at runtime | installed package.json exports |

Line numbers are evidence locators for this installation, not portable API contracts.
Implement probes using resolved installed package paths; never hardcode Hadi's global
path into a distributed package. Reinspect on upgrades.

## Local framing experiment

Read a stream containing `a\u2028b\u2029c\nd\re\r\nf` with Node readline on the
installed runtime. It yielded six lines (`a,b,c,d,e,f`). An LF-only JSONL protocol must
preserve U+2028/U+2029 inside JSON strings, so use byte LF framing instead.
Reference: [Node readline](https://nodejs.org/api/readline.html).

## Browser transport facts

Native EventSource accepts URL/withCredentials, not arbitrary Authorization headers;
Last-Event-ID is the last emitted event ID string, not automatically a Pi entry cursor.
Comments do not dispatch ordinary JS data events; heartbeats for a JS watchdog must be
observable data events. Reconnect can duplicate deliveries; application snapshot and
reducer rules provide reconciliation. [WHATWG SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html).

## Palette evidence retained from original plan

The original visual plan transcribes installed theme asset roles and `okhsl` values.
Keep those as the proposed source mapping in visual_design.md; implementation must
revalidate assets/var resolution/conversion, licensing and contrast against the resolved
package. Exact terminal `system` appearance cannot be inferred in a browser.
No claim that a palette generator or contrast audit already exists/passes.

## Unproven until P0

Terminal remote answering of other extensions' UI, bridge snapshot atomicity and live
entry mapping, command-context operations outside command handlers, queue clearing/state,
noninteractive trust parity, reload/Paseo coexistence, packaging/schema compatibility,
and actual NetBird phone/HTTPS reachability. Existing type names are not behavioural tests.

No installed Pi/Paseo extensions, production session files, credentials, models or network
configuration were changed by this plan review.
