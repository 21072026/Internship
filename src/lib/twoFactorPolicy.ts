import { getSetting } from '@/lib/settings';

export type Require2faMode = 'off' | 'admins' | 'admins_mentors';

// Whether the org's 2FA policy requires this role to have 2FA enabled.
// Kept server-side (reads the Setting table) so both layout guards and the
// admin settings UI agree on the rule.
export async function is2faRequiredFor(role: string): Promise<boolean> {
  const mode = (await getSetting('require2fa')) as Require2faMode;
  if (mode === 'admins') return role === 'ADMIN';
  if (mode === 'admins_mentors') return role === 'ADMIN' || role === 'MENTOR';
  return false;
}
