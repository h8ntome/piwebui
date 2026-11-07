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

## Release process (automated)

npm packages live under the `piwebui` org: `@piwebui/shared`, `@piwebui/pi-adapter` and
`@piwebui/pi-web` (the server + CLI; `bin` is `piweb`, deliberately not `pi-web`, which is
already used by an unrelated package on npm). The web client is `private: true` and is not
published — it is built into `@piwebui/pi-web` as `client-dist`.

Releasing is one command:

```bash
# 1. bump all three manifests to the same version, commit
# 2. tag it and push the tag
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` then checks the tag against every manifest, runs
`npm run build` and `npm run package:smoke` (pack → clean install → boot → authenticated
probe), publishes in dependency order with `--provenance`, and prints the version the
registry reports back. Nothing else publishes; pushing commits does not touch npm, because
npm versions are immutable and a commit-triggered publish would fail on the next push.

One-time bootstrap, per package, because npm cannot configure a trusted publisher for a
package that does not exist yet: the first `npm publish` of each must be done locally with a
granular token (`npm publish -w ./packages/shared --provenance` etc.), then on each package's
npm page enable **Trusted Publishing → GitHub Actions** for repo `h8ntome/piweb`, workflow
file `release.yml`. After that the tag flow needs no token at all. If you would rather skip
trusted publishing, store a granular publish token as the repo secret `NPM_TOKEN`; the
workflow already passes it through, and it is ignored when empty.

Internal dependency ranges are caret versions (`^0.1.0`), not the `workspace:*` protocol:
`npm pack` does not rewrite `workspace:*` in this layout, so a published tarball carrying it
is uninstallable (`EUNSUPPORTEDPROTOCOL`). Bump all three manifests together.

There is no published release yet and no tag; the version in every manifest is `0.1.0`.

## Verifying a claim before it reaches the README

`docs/CAPABILITY_MATRIX.md` is generated from `e2e/p0-capability-matrix.ts` and mirrors the README's
runtime claims. If you add a claim to the README, add the matrix row that proves it, or the project
loses the one property that makes it trustworthy: every promise is checked.
