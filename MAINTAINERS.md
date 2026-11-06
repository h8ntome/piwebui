# Maintainer guide

Small project, one maintainer, no bot army. This is the workflow that is actually sustainable.

## The 24-hour rhythm (when you have time)

The goal is that nobody files an issue into a void, not that everything is fixed quickly.

1. **New issue → triage the same day if possible, within a few days at worst.**
   - Read it. If the repro is missing, comment one specific question and add `needs-repro`.
   - If it is real and scoped, add `bug`/`enhancement` plus one area label (`ui`, `pi-integration`, `perf`).
   - Add `needs-triage` when you cannot get to it yet; remove it once handled. It is the "seen, not forgotten" marker.
2. **Acknowledge with something useful.** A one-line "Confirmed on <commit>, this is the read worker
   refusing a non-allowlisted root — I think the fix is X, no workaround yet" is worth more than any
   auto-reply. Never close as `stale` without a human note.
3. **Feature requests** get either a pointer to the capability matrix row that governs them or a short
   "out of scope because pi stays the only runtime/writer" with a link to the rule. Both are answers.
4. **Bots and Dependabot PRs** are merged when CI is green and the change is patch/minor; version bumps
   of majors wait for a manual check, since the client pins `marked`, `dompurify` and `highlight.js`.

Do not run stale-issue automation. For a project this size, closing three-month-old issues that nobody
answered produces a worse repository than leaving them open.

## Issue hygiene worth keeping

- Reproduce locally with a throwaway `--data-dir` before believing a report; several classes of bug here
  are environment-specific (Node version, installed pi version, macOS case-insensitive paths).
- When a report is really "pi behaves differently", label `pi-integration` and add the exact pi version.
- Convert good support answers into Discussions threads rather than long issue comment chains.
- Add a `good first issue` only when you would genuinely accept a stranger's patch for it, and include
  the file paths that need to change — `docs/GOOD_FIRST_ISSUES.md` has the current set.

## Release process

There is no published release yet and no tag; `0.1.0` is the version in every workspace manifest and
every manifest is still `"private": true`.

For the first release:

1. Decide whether the packages get published to npm. That is the only way to offer `npm i -g` instead
   of clone-and-build; it means flipping `"private": true` in all four manifests, adding `repository`,
   `publishConfig.access: public` for the scoped packages, and a `prepublishOnly` that runs
   `npm run build`. Do not claim an npm install path before that is true and verified in a clean
   environment.
2. Update `CHANGELOG.md`: move the `Unreleased` section to `## [0.1.0] - YYYY-MM-DD`, keep the "known
   state of the suites" table honest, and state the four failing smoke checks as known limitations.
3. Bump all four package versions in one commit (`0.1.0`), tag `v0.1.0`, and push the tag.
4. Create the GitHub release from the tag with the notes below (see the launch copy in the audit
   document). Do not attach binaries; the artifact is the source tag plus, if published, npm.

## Verifying a claim before it reaches the README

`docs/CAPABILITY_MATRIX.md` is generated from `e2e/p0-capability-matrix.ts` and mirrors the README's
runtime claims. If you add a claim to the README, add the matrix row that proves it, or the project
loses the one property that makes it trustworthy: every promise is checked.
