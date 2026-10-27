# 2026-10-27 — Config events with a redacted diff (#1699)

- **Internal catalogue entries with no producer can be reshaped in place.** The
  "a change is a new version" rule protects receivers; `org.config.changed` & co.
  had never been raised, so their v1 got the `changes` array directly. Say so in
  the catalogue comment so the next agent does not read it as precedent for a
  public entry.
- **A subscriber that writes AuditLog makes "every row of this actor" e2e
  assertions racy.** The row arrives through the 5 s job worker, sometimes inside
  the test, sometimes not. Filter such queries by `action: { in: expected }`
  (`org-write-audit-trail.spec.ts`) and poll for the async row in its own spec.
- **Local e2e in this container:** `.env` is not read by the Playwright workers'
  own Prisma client — `set -a && . ./.env && set +a` before `npx playwright test`.
  The pinned headless shell was `-1248` with `-1243` installed: a symlink of both
  `chromium-*` and `chromium_headless_shell-*` dirs under `/opt/pw-browsers` works.
- Keep a subscriber's Prisma import lazy (`await import('@/lib/prisma')`) so its
  pure half loads in a `*.unit.spec.ts`.
