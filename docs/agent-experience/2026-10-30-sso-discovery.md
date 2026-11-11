# 2026-10-30 — Per-tenant SSO discovery (#1665)

- **Old issues predate the code that answers half of them.** #1665 (written 2026-08) asked for
  `ssoEnforced` and a server refusal; #1950 had shipped both. It also asked to move the SP
  identifiers to the custom domain, which CLAUDE.md's #2494 rule ("SSO keeps its ONE registered
  endpoint") now forbids. Read the issue against today's CLAUDE.md and say in the claim comment
  what you are dropping and why.
- **Host-dependent server pages are testable without a browser:** `request.get(path, { headers:
  { 'x-forwarded-host': host }, maxRedirects: 0 })` and assert on the HTML / the `Location`.
  Use a unique host per test: `resolveOrgFromHost` caches each host for 60 s, a miss included.
- **`e2e/sso-enforced.spec.ts:146` is slow on a cold `next dev`** (2.9 min warm); its 15 s
  per-request timeout trips on first compile. Re-run it once before suspecting a change.
