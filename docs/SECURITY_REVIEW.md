# Security review — pi-web @ `62447b7`

Reviewed 2026-11-07 against the committed tip. Repository had **no public git remote configured** at
review time, so nothing reviewed here was published. Findings are ordered by priority; the full text
first appeared only in a private working branch.

> **Update, same day:** the login page and the whole one-use bootstrap-code path were removed after this
> review was written (see `CHANGELOG` → Removed and `SECURITY.md` → “Access model: no login”). Statements
> below about `bootstrap_codes`, `mint-code` and code-based browser login describe the pre-removal code.
> What did not change: the constant-time-comparison note in P3 still applies to cookie and CSRF lookups,
> and the rate limiter is still best-effort — with no login at all it matters even less, and `--bind` plus
> `--host-allow` remain the controls that protect a mis-bound instance.

## P1 — Accidental local proxy advertised a mesh-only token as a public URL (resolved)

An earlier revision of the README documented a "public proxy" on port 8443 that forwarded to the
pi-web server and stated that the token was carried in the URL. The actual service was
NetBird-interface-only and used a shared-IP allowlist rather than per-user authentication, so the
documentation described — and thereby encouraged — a credential that would have been exposed in
browser history, proxy access logs and `Referer` headers if anyone had built the public exposure it
described. On this checkout the whole section is gone and the README states loopback-only + mesh +
per-request auth instead.

**Verification:** `git grep -nE "8443|token in URL"` returns no matches in tracked files. The server
stores bootstrap codes, cookies, CSRF values and API tokens only as SHA-256 hashes
(`packages/server/src/auth.ts`), and a scan of tracked history for provider-key, GitHub-token, Slack
token and private-key patterns found no live credentials.

**Still required of the maintainer:** nothing to rotate on this checkout for that finding. Had the
repository been published, the correct response would have been history scrubbing plus rotating the
shared password and every pi-web API token before the next public push.

## P2 — `plan/` and `.plan-review-backup-2026-11-05/` are committed and contain local paths

28 planning documents carry the original author's absolute home paths (for example
`/Users/hadi/Documents/sandbox/chat-client`, `~/.pi/agent/models.json`) and a dated backup copy of
the plan set. These are not credentials, but they are unnecessary personal filesystem disclosure in a
public repository and they make the repo harder for a stranger to reason about.

**Remediation:** move design documents under `docs/` (or keep them private), delete the dated backup
directory, and scrub absolute home paths to placeholders before the first public push. `docs/CHECKS.md`
already uses `<redacted-user>` placeholders for the same paths; apply the same treatment to `plan/`.
Because these files were only ever on a local clone so far, this can be fixed before publication
rather than requiring a history rewrite afterwards.

## P2 — Committed SQLite artifact: `true/metadata.db`

A stray `--data-dir true` run left a real (if empty) pi-web database in the tree; it is tracked.
It contains two `bootstrap_codes` rows (hashed values, since expired) and no workspace or session rows,
so no private data leaked — but committing a live data directory's database is the kind of accident
that eventually leaks one.

**Remediation:** `git rm -r --cached true && rm -rf true`, and extend `.gitignore` with `*.db`,
`*.db-wal`, `*.db-shm`, and a default `~/.pi-web` note so a mistyped data dir cannot be committed again.

## P3 — Non-constant-time comparison of stored hashes

`auth.ts` compares `hash(supplied) === row.csrf_hash` (and equivalent cookie lookups) with `!==` rather
than `crypto.timingSafeEqual`. Comparing a hash is not practically timing-exploitable — an attacker
cannot invert SHA-256 to choose a matching prefix — so this is recorded as a hardening note, not a
vulnerability. The bootstrap-code path already uses `timingSafeEqual`. Prefer routing every secret
comparison through one constant-time helper so the property stays true after future edits.

## P3 — In-memory rate limiter and unbounded bootstrap minting

`Auth.rateOk` is a per-principal token bucket (600/min) held in process memory, and the bucket map is
cleared wholesale when it exceeds 1000 entries. A client that is not yet authenticated has no principal
to be bucketed against, and `mint-code` is a local CLI command, so the practical exposure is small on
a loopback listener. It is worth documenting that the limiter is best-effort and per-process, and that
rate limiting is not the control that protects a mis-bound instance — `--bind` and `--host-allow` are.

## Verified-good posture (worth keeping)

- Fail-closed pi version gate: unvalidated pi disables runtime features instead of guessing.
- Read paths execute in a separate worker restricted to allowlisted roots, and originals are opened
  without `SessionManager.open` (verified to rewrite files), so browsing cannot mutate session data.
- CSP on every response: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; object-src 'none';
  base-uri 'self'; form-action 'self'`.
- `DOMPurify` allow-list sanitization of markdown output rather than blacklisting.
- Structured logs that deliberately exclude prompt text, tool output and secrets.
- Bounded payload sizes with explicit errors instead of silent truncation.

## Recommendations, in order

1. Scrub `plan/` + the dated backup dir of absolute home paths, or keep them out of the public repo.
2. Untrack and delete `true/`; add `*.db` patterns to `.gitignore`.
3. Add the two CI workflows and make the unit + build gates blocking before the first public push.
4. Keep the internal-only material (local paths, unverified performance numbers, personal
   configuration) out of published files; anything labelled `docs/SECURITY_INTERNAL.md` must stay
   untracked — this file deliberately replaces the need for one.
5. Decide on a GitHub token with ` Administration: read-write` if the repository is made public via the
   `gh` CLI, so topics, Discussions and the social preview image can be applied in the same pass.
