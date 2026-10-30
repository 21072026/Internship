# 2026-10-30 — Admin tier & scope assignment (#1579)

- **A pure module that the browserless unit tests import must not runtime-import another
  module via `@/`** — and `scripts/test/nav-*.test.mjs` load `src/lib/navLinks.ts` without the
  extensionless resolve hook, so even `./authzRule` fails there. Keep such files' cross-imports
  `import type` and let the caller pass computed values in (`NavAudience.permissions`).
- **The issue's "last SUPER_ADMIN" maps to the org's last active ORG_ADMIN.** There is no
  SUPER_ADMIN tier (CLAUDE.md, #2647); the platform flag is set by a script only.
- **The demotion guard is unreachable through the running app** (the actor is itself an active
  ORG_ADMIN of the same org), so it is pinned in the unit test; the e2e proves the reachable
  instance of the same rule — the last ORG_ADMIN deleting their own account while observers exist.
- **A tier change needs a sign-out, a grant change does not:** the tier rides in the JWT, grants
  are read live by `requirePermission()`.
