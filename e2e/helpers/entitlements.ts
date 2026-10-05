import type { Page } from '@playwright/test';
import { prisma, setOrgFeature } from './db';

/**
 * Switch a paid feature on or off for the org of whoever is signed in on
 * `page` (#1740) — what the analytics specs used to do through the retired
 * premium-analytics setting. Reads the session to find the user, then writes
 * the org grant `entitled()` resolves. An org-less user is the default org's.
 */
export async function setOrgFeatureFor(page: Page, feature: string, on: boolean): Promise<string> {
  const session = await (await page.request.get('/api/auth/session')).json();
  const userId: string | undefined = session?.user?.id;
  if (!userId) throw new Error('setOrgFeatureFor: no signed-in user on this page');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
  return setOrgFeature(user?.orgId ?? null, feature, on);
}
