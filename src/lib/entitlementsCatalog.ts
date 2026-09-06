// Pure premium-feature catalogue — no DB imports, so it is safe to use from
// client components (the admin toggle UI) as well as the server. The DB-backed
// helpers live in src/lib/entitlements.ts.

// `scope` says WHICH axis decides a feature, because there are two and they are
// not interchangeable (#1742):
//   'company' — a CompanyEntitlement row, toggled per hiring company on
//               /admin/companies. That is what src/lib/entitlements.ts reads.
//   'org'     — the TENANT's plan (Organization.plan → orgPlanHasFeature in
//               src/lib/orgPlans.ts). White-label branding and SAML SSO belong
//               to the customer running the program, not to a company in their
//               talent pool, so no per-company toggle can grant them; the
//               company screen renders them read-only and says so.
// #1733 unifies the two axes behind one entitled() helper; until then this
// field is what keeps the admin UI from promising something it cannot deliver.
export const PREMIUM_FEATURES = [
  { key: 'TALENT_POOL_SEARCH', phase: 1, scope: 'company' },
  { key: 'VERIFIED_CANDIDATE_CARD', phase: 1, scope: 'company' },
  { key: 'COMPANY_NEED_MATCH_ALERTS', phase: 1, scope: 'company' },
  { key: 'EARLY_ACCESS', phase: 1, scope: 'company' },
  { key: 'AI_PACKAGE', phase: 2, scope: 'company' },
  { key: 'ADVANCED_ANALYTICS', phase: 2, scope: 'company' },
  { key: 'REPORT_EXPORT', phase: 2, scope: 'company' },
  { key: 'WHITE_LABEL', phase: 3, scope: 'org' },
  { key: 'SSO_SAML', phase: 3, scope: 'org' },
] as const;

export type PremiumFeature = (typeof PREMIUM_FEATURES)[number]['key'];

const FEATURE_KEYS = new Set<string>(PREMIUM_FEATURES.map((f) => f.key));

export function isPremiumFeature(value: unknown): value is PremiumFeature {
  return typeof value === 'string' && FEATURE_KEYS.has(value);
}
