# Risks and remaining engineering questions

User choices and corrections are in [review_and_decisions.md](review_and_decisions.md).
No routine framework/name/port question needs to block progress: retain pi-web as working
name, React, explicit allowlists, localhost:4319, independent project, Pi-derived theme
with override and read-only tool-result diffs. Public package ownership/name is not assumed.

## Risk register

| ID | Risk | Required mitigation/gate |
|---|---|---|
| R-01 | Two runtimes write one file | Existing live sessions use bridge; no force takeover; canonical reservations; unbridged resume requires confirmed closed writers with residual risk disclosed. |
| R-02 | Public terminal API lacks required control/dialog state | P0 real extension tests and per-driver capability matrix. Do not claim RPC capabilities exist in extensions. |
| R-03 | Reconnect loses unfinished preview/branch/dialog | Owner cumulative snapshots + barrier; generation binding and bounded replay, explicit resync. |
| R-04 | GET migrates/rewrites sessions | Pure read worker, memory-only migration; byte/mtime assertions on empty/legacy/real-format fixtures. |
| R-05 | Remote endpoint enables account-level Pi control | Authenticated HTTPS over verified NetBird path, Host/CSRF/path/socket tests. |
| R-06 | Pi upgrade silently breaks contracts | Resolved-package fingerprint + tested version/adapter; fail read-only on unverified writes. |
| R-07 | SDK prompt blocks abort or ACK | Separate dispatch from completion; runtime actor accepts urgent commands while run promise is pending. |
| R-08 | Ambiguous retry duplicates work | Transactional operation reservation, owner deduplication, unknown state after crash; no automatic prompt replay. |
| R-09 | Browser absence kills long run | No browser timeout; clean up only settled hosts, four-session close/sleep test. |
| R-10 | False exact-context/current-status display | Label persisted projection vs runtime preview, unknown state for file mirrors; no exact provider payload guarantee. |
| R-11 | Cumulative tool update duplication | Bash replace policy verified against installed source; unknown tools replace until tested. |
| R-12 | Memory grows despite virtualization | Byte limits, paged bodies, snapshot bounds, giant-record tests and four-host resource measurements. |
| R-13 | Existing Paseo bridge conflict | Read-only inspection/coexistence proof before using shared hooks; no active process reload/patch without user instruction. |
| R-14 | Live branch mistaken for foreign writer | Owner leaf events + file correlation; parent mismatch alone is not divergence. |
| R-15 | Scope exceeds maintainer capacity | P0 feasibility before estimate; required release gates explicit; advanced mutations/RPC/export deferred. |
| R-16 | Raw stderr/log/idempotency cache leaks data | Content-free diagnostics, safe operation receipts only, privacy tests. |

## Engineering questions to resolve through evidence

1. Can supported terminal extension APIs provide a consistent preview snapshot and
   remote response to *other extensions'* dialogs? UIPromptStart/End observation alone
   does not answer this. If no, what minimal supported Pi adapter is required?
2. Which queue stats/clear/command-context operations are available in a normal extension
   callback? Expose only proven capabilities, keep unsupported UI disabled with reason.
3. How does the installed extension `message_update` wrapper expose live cumulative/delta
   state, and how are live messages mapped to persisted entries without heuristics?
4. What current NetBird host/DNS/HTTPS path reaches the phone, and can existing trusted
   certificates/proxy be reused without affecting services? Verify instead of assuming.
5. What is the configured Pi agent/session directory and selected model/tool/trust state
   on each target? Read owning config, never replace settings for convenience.
6. What packaging combination supports the runtime floor and selected schema/SQLite
   adapters on clean macOS/Linux installations? Pin after a real install smoke test.

None of these are permission requests for plan edits. If P0 proves a necessary upstream
change or a genuine scope conflict, present the concrete evidence and narrowly scoped
choice to Hadi; do not make an unapproved installed-app change or hide a missing feature.

## Future work

RPC fallback; interactive tree/fork navigation; export/trash; git read adapters; PWA;
Windows certification; multi-host aggregation. An advisory session-file lock only helps
when **all** writers participate; it never retroactively fences arbitrary ordinary Pi.
