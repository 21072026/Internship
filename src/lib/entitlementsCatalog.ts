// Pure premium-feature catalogue — no DB imports, so it is safe to use from
// client components (the admin toggle UI) as well as the server. The DB-backed
// helpers live in src/lib/entitlements.ts.

export const PREMIUM_FEATURES = [
  { key: 'TALENT_POOL_SEARCH', phase: 1 },
  { key: 'VERIFIED_CANDIDATE_CARD', phase: 1 },
  { key: 'COMPANY_NEED_MATCH_ALERTS', phase: 1 },
  { key: 'EARLY_ACCESS', phase: 1 },
  { key: 'AI_PACKAGE', phase: 2 },
  { key: 'ADVANCED_ANALYTICS', phase: 2 },
  { key: 'REPORT_EXPORT', phase: 2 },
  { key: 'WHITE_LABEL', phase: 3 },
  { key: 'SSO_SAML', phase: 3 },
] as const;

export type PremiumFeature = (typeof PREMIUM_FEATURES)[number]['key'];

const FEATURE_KEYS = new Set<string>(PREMIUM_FEATURES.map((f) => f.key));

export function isPremiumFeature(value: unknown): value is PremiumFeature {
  return typeof value === 'string' && FEATURE_KEYS.has(value);
}
