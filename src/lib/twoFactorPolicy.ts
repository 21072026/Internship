import { getSetting } from '@/lib/settings';
import { parseRequire2faMode, roleCoveredBy, type Require2faMode } from '@/lib/twoFactorPolicyRule';

export type { Require2faMode };

// Whether the org's 2FA policy requires this role to have 2FA enabled.
// Kept server-side (reads the Setting table) so both layout guards and the
// admin settings UI agree on the rule; the vocabulary itself — which mode
// covers which role — is pure in src/lib/twoFactorPolicyRule.ts (#1644).
//
// `orgId` is REQUIRED (#2628): the layout guards that call this run outside any
// tenant scope, so without it they read the global row — and a tenant admin's
// `require2fa` lives in that tenant's own row. Pass `settingsOrgOf(session)`.
export async function is2faRequiredFor(role: string, orgId: string): Promise<boolean> {
  return roleCoveredBy(await require2faModeOf(orgId), role);
}

/** The org's effective policy, parsed (an unknown stored value reads as `off`). */
export async function require2faModeOf(orgId: string): Promise<Require2faMode> {
  return parseRequire2faMode(await getSetting('require2fa', orgId));
}
