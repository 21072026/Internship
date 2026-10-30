// Partner applications (docs/affiliate-module.md, #3361) — the one writer of
// AffiliateApplication rows from the public form. Server-only.
//
// The form is sessionless, so nothing binds a tenant context: the org comes from
// the host (affiliateProgrammeForHost) and is passed on every create and WHERE.
// What the sender learns is deliberately nothing: whether a row was created, an
// application was already pending, the address is a partner already or the daily
// cap was hit, the route answers the same 200 — anything else would let a
// stranger test which addresses a programme knows.

import { prisma } from '@/lib/prisma';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';
import { notify } from '@/lib/notify';
import { orgWhere } from '@/lib/tenantFilter';
import { sendAffiliateApplicationReceivedEmail } from '@/services/emailService';
import { APPLICATIONS_PER_ADDRESS_PER_DAY, type AffiliateApplicationInput } from '@/lib/affiliateApplicationRule';

export type SubmitOutcome = 'created' | 'pending_exists' | 'capped';

export async function submitAffiliateApplication(args: {
  orgId: string;
  application: AffiliateApplicationInput;
  locale: string | null;
}): Promise<SubmitOutcome> {
  const { orgId, application, locale } = args;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [pending, recent] = await Promise.all([
    prisma.affiliateApplication.count({ where: { orgId, email: application.email, status: 'PENDING' } }),
    prisma.affiliateApplication.count({ where: { orgId, email: application.email, createdAt: { gte: since } } }),
  ]);
  // One open application per address is enough for an admin to answer; a second
  // one would only be a duplicate row to reject.
  if (pending > 0) return 'pending_exists';
  if (recent >= APPLICATIONS_PER_ADDRESS_PER_DAY) return 'capped';

  await prisma.affiliateApplication.create({
    data: {
      orgId,
      ...application,
      locale,
      // The consent record: when, and which privacy text — from the server. No IP is stored.
      consentAt: new Date(),
      consentTextVersion: PRIVACY_POLICY_VERSION,
    },
    select: { id: true },
  });

  // The org's active admins hear about it in the app (a link to the list, #3362).
  // Their org only: orgWhere() is the same rule their list applies.
  const name = `${application.firstName} ${application.lastName}`;
  const admins = await prisma.user.findMany({
    where: { AND: [{ role: 'ADMIN', isActive: true }, await orgWhere(orgId)] },
    select: { id: true },
  });
  await Promise.all(admins.map((a) => notify(a.id, 'affiliate_application.new', { name }, '/admin/affiliates/applications').catch(() => {})));

  // A failed acknowledgement never turns a stored application into an error.
  try {
    await sendAffiliateApplicationReceivedEmail({ to: application.email, firstName: application.firstName, locale, orgId });
  } catch (e) {
    console.error('Affiliate application acknowledgement failed:', e);
  }
  return 'created';
}
