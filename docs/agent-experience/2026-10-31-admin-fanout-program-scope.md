## 2026-10-31 — admin fan-outs follow the program scope (#3485)

- **Put the tier filter in the server helper, not in the pure org rule.** `tenantAdminWhereFor()`
  is unit-tested for its exact shape; the org-level tier conjunct (`ORG_LEVEL_ADMIN_WHERE`) is
  ANDed in `tenantAdmins.ts`, so the org rule and its tests stay untouched and every existing
  caller became org-level at once.
- **`grep "role: 'ADMIN'" | grep isActive` finds the fan-outs; counts (`metering`, `ssoEnforcement`,
  `adminTiers`) and owner picks (`klaviyoSync`) are not notices** — leave them.
- **A Prisma enum column in a pure module:** spell the values as strings and cast once at the
  server boundary (`as Prisma.UserWhereInput`); an `as const` literal is `readonly` and Prisma's
  `OR` wants a mutable array.
