# 2026-10-30 — Per-organization impersonation policy (#1586)

- **A central write refusal belongs before middleware's allowlist bypass.** `isAllowlisted()` lets
  public forms (`/api/apply`, `/api/rsvp`, …) skip the token lookup entirely; a rule about WHO is
  writing must decode the token before that shortcut, for write methods only.
- **Policy-carrying claims go on the grant row, not the session lookup**: the edge middleware has
  no database, so `readOnly` is stamped on `ImpersonationGrant` at start and copied into the JWT by
  the `impersonate` provider — the middleware then reads the claim alone.
- **`pkill -f "<pattern>"` inside a Bash tool call kills that very shell** when the pattern
  appears on its own command line (exit 144). Run `pkill` as its own command, or match by PID.
- **`next dev` cannot carry the heavy admin specs here** (authz-matrix, /admin/users lists): they
  time out cold. `npm run build` once, then `CI=1 npx playwright test …` runs them on `next start`.
