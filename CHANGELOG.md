# Changelog

All notable changes to pi-web are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims for
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts here: pi-web has been developed in a single working branch so far, and **`0.1.0` (the
version currently declared in every workspace manifest) has not been tagged or published yet**. No
historical releases are back-filled below — the first real release cut will replace the `Unreleased`
section with a dated entry.

## [Unreleased]

### Added

- GitHub Actions CI (`npm run typecheck`, `npm run test:unit`, `npm run build` on Node 22.19 and 24.x,
  with the client bundle uploaded as an artifact).
- A separate advisory e2e workflow that runs the full-stack smoke against pi 1.5.0 and records the
  four currently-known failures instead of hiding them.
- `SECURITY.md` with the supported-versions table, private disclosure route, and an explicit statement
  of what the server enforces and what its trust model does and does not promise.
- `docs/SECURITY_REVIEW.md`: dated review of the committed tip, including findings already resolved
  and lower-priority hardening notes.
- `CONTRIBUTING.md` with verified setup commands, repository map, test matrix, conventions (including
  why reads must never call `SessionManager.open()`), and a troubleshooting table.
- Issue templates (bug report, feature request) and a pull-request template that require real evidence.
- `CODE_OF_CONDUCT.md` and `.editorconfig`.
- Unit-suite goldens pinning the vendored OKHSL math against the upstream reference implementation.

### Changed

- The README now leads with the main UI instead of the login card: `docs/assets/screenshot-main.png`
  shows a session transcript (session list, thinking, tool calls with results, markdown, the follow-up
  commit) captured from a real local build at 1600x1000 @2x against synthetic demo data. The login
  still stays in `docs/assets/` as frame 1 for the planned GIF, and `docs/DEMO_CAPTURE.md` §0 records
  how the still is reproduced.

### Fixed

- **Theme colors rendered as clipped primaries.** `chromaStops()` in the vendored OKHSL code was
  missing the outer reciprocal on both harmonic means relative to `pi-tui`'s reference implementation,
  which inflated `c0`/`cMid` and pushed every saturated color out of gamut. `okhsl(40 10% 90%)`
  rendered `#ff0000` instead of `#e7e1df`; `okhsl(265 40% 60%)` rendered `#ff00ff` instead of
  `#7b90bf`. Now byte-for-byte identical to upstream across a 19,656-point grid, and pinned by goldens.
- Stray `true/` SQLite artifact and the `.plan-review-backup-*` snapshot are no longer tracked, and
  database files are ignored so a mistyped `--data-dir` cannot commit one again.
- Stale documentation pointer to a `scripts/contrast-audit.ts` that does not exist in this repository.

### Known state of the test suites

Honest, as of this commit, on Node 24 with pi 1.5.0 installed:

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run test:unit` | pass (9 tests) |
| `npm run build` | pass (client bundle, no source maps) |
| `npm run smoke` | **18/22** — `S13`, `S17`, `S18`, `S20` fail on the committed tip and are open work |
| `npm run p0:verify` | not re-run in this pass; see `docs/CAPABILITY_MATRIX.md` for its last recorded result |
