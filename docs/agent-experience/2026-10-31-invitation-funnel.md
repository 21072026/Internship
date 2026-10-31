## 2026-10-31 — invitation funnel (#1921, slice 1)

- **Read the schema before you plan columns.** The issue asked for `openedAt`, `registeredAt`
  and `activatedAt` on `InvitationToken`; the first two already existed (#2071's status
  board), and "activated" could be derived from `User.lastLoginAt` because registration
  redirects to the sign-in page. The slice shipped with no schema change.
- **An e-mail lookup needs an org pin.** `check:user-email-lookups` accepts
  `withinTenant({ email: { in } }, await orgWhere(org))` as pinned. Map a NULL-org
  invitation to `defaultOrgId()` before the lookup, the same rule `tenantWhere` applies.
- **A new shared `reports.*` label is a MARKETING leak.** `reports.role.MENTOR/MENTEE` broke
  the `check:i18n` leak ratchet (allowed 0). The fix is an overlay entry beside the existing
  `reports.col` overlay in all three locales, not a ratchet bump.
- **A legally blocked issue can still ship its unblocked half.** The draft comment on #1921
  separated the in-app signals (no new privacy text) from the pixel and click tracking
  (consent question). Claim the half you take, by name, so nobody reads the issue as done.
