import { getSetting } from '@/lib/settings';

export type Require2faMode = 'off' | 'admins' | 'admins_mentors';

// Whether the org's 2FA policy requires this role to have 2FA enabled.
// Kept server-side (reads the Setting table) so both layout guards and the
// admin settings UI agree on the rule.
//
// `orgId` is REQUIRED (#2628): the layout guards that call this run outside any
// tenant scope, so without it they read the global row — and a tenant admin's
// `require2fa` lives in that tenant's own row. Pass `settingsOrgOf(session)`.
export async function is2faRequiredFor(role: string, orgId: string): Promise<boolean> {
  const mode = (await getSetting('require2fa', orgId)) as Require2faMode;
  if (mode === 'admins') return role === 'ADMIN';
  if (mode === 'admins_mentors') return role === 'ADMIN' || role === 'MENTOR';
  return false;
}
