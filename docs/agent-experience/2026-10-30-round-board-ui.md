# 2026-10-30 — Round review board UI (#1796, part 2)

- **Nullable booleans in a Prisma filter:** `acceptingMentees: { not: false }` compiles to
  `<> false`, which drops NULL rows in SQL — and NULL is "never set", i.e. accepting. Use
  `OR: [{ acceptingMentees: null }, { acceptingMentees: true }]`.
- **A new admin page outside the sidebar is not in the mobile layout audit**
  (`e2e/mobile-layout-coverage.spec.ts` audits sidebar destinations only); give native checkboxes
  `h-6 w-6` anyway so the page passes the 24px target-size rule the day it gets a nav entry.
- **Adding a sidebar entry is more than `navLinks.ts`:** the native app menu needs an icon in
  `apps/mobile/src/lib/menu.ts` (unit-tested) and the audit lists it — linking the board from the
  existing `/admin/matching` page avoided that churn for a sub-page.
- `mobile-layout-coverage` was red on main for other sessions' pages (`/admin/automations`,
  `/admin/announcements` …) while this landed — check `git diff origin/main --stat` before
  chasing an e2e red into your own diff.
