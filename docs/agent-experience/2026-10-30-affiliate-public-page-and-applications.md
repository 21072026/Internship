# 2026-10-30 — affiliate public page, applications and portal follow-ups (#3358, #3346, #3347)

- **A public page for one tenant is generic code plus that tenant's DATA.** The programme
  page (`/partner`) copies another site's layout, but every word, phone number and link
  comes from `AffiliateProgramSettings.landing`; the code carries only dictionary fallbacks.
  Writing the tenant's wording into the page would have failed the forbidden-terms guard
  and the repo rule at once. Check the schema for an unused column before adding one —
  `landing Json?` had existed, unread, since #3114.
- **Sessionless public pages and forms resolve the org with `resolvePublicInquiryTarget()`**
  (`src/lib/publicHostOrg.ts`), the same resolver and trust note as the company-inquiry form.
  `resolveOrgFromHost()` (`src/lib/hostOrg.ts`) is for branding and SSO and needs a VERIFIED
  host; locally neither `marketing.localhost` nor an unverified host maps to an org, so use
  the demo org's `publicHost` (`acme.localhost` in the local seed) to see the page.
- **A page that 404s where nothing is configured must stay out of `PUBLIC_ROUTES`:**
  `e2e/robots-sitemap.spec.ts` resolves every listed route. Record the omission in the
  comment block of `src/lib/publicRoutes.ts` instead.
- **A new sessionless route needs five registrations, each found by its own CI check:**
  `scripts/route-auth-baseline.json` (`check:route-auth`), a mail category in
  `emailGroups.ts` and `OUTBOUND_CATEGORIES` (plus the exempt list in
  `scripts/test/outbound-approval-rule.test.mjs`), a notification in
  `notifications/catalog.ts` + its `notifications.events` string, a retention entry and its
  row in `docs/pii-access-lifecycle.md`, and `freshIp(label)` from `e2e/helpers/rateLimit.ts`
  in every e2e call to the rate-limited route (`check:e2e-rate-limits`).
- **Copy that explains money must be checked against the engine, not the plan's field
  names.** "From customer no. N: X % of every payment" was wrong twice (the public page and
  the portal box): the engine pays the percent from that moment on to ALL eligible
  customers, each within its own window (`affiliateCommissionRule.ts`). A second reviewer
  caught it in one PR; grep for the same sentence in sibling PRs.
- **Run the touched Playwright specs locally before pushing when `main` is red.** With
  `check:erasure-coverage` failing on `main`, CI skipped everything after it, so the PRs
  had no real signal. Stop any running dev server on :3000 first: Playwright reuses it, and
  its `MARKETING_HOSTS` differs from the suite's (`marketing.example.test`).
- **Parallel subagents in worktrees worked well for independent issues** (symlink
  `node_modules` from the main checkout instead of `npm install`), and an independent
  `reviewer` pass on their PRs found real money/race defects. Two PRs appending tests to
  the same spec file will conflict; whichever merges second needs a rebase.
