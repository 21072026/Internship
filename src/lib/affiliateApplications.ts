// Partner applications (docs/affiliate-module.md, #3361) — the one writer of
// AffiliateApplication rows from the public form. Server-only.
//
// The form is sessionless, so nothing binds a tenant context: the org comes from
// the host (affiliateProgrammeForHost) and is passed on every create and WHERE.
// What the sender learns is deliberately nothing: whether a row was created, an
// application was already pending or the daily cap was hit, the route answers
// the same 200 — and in the same time: the admins' notice and the applicant's
// mail are returned as a follow-up the route runs AFTER the response (`after()`),
// because an SMTP round trip only on the "created" branch would tell a stranger
// which addresses have a pending application.

import { prisma } from '@/lib/prisma';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';
import { notify } from '@/lib/notify';
import { orgWhere } from '@/lib/tenantFilter';
import { can } from '@/lib/authz';
import { adminTierFor } from '@/lib/authzRule';
import { lockOrganization } from '@/lib/affiliatePartners';
import { sendAffiliateApplicationReceivedEmail } from '@/lib/affiliateApplicationMail';
import { APPLICATIONS_PER_ADDRESS_PER_DAY, type AffiliateApplicationInput } from '@/lib/affiliateApplicationRule';

export type SubmitOutcome = 'created' | 'pending_exists' | 'capped';

export async function submitAffiliateApplication(args: {
  orgId: string;
  application: AffiliateApplicationInput;
  locale: string | null;
}): Promise<{ outcome: SubmitOutcome; followUp: (() => Promise<void>) | null }> {
  const { orgId, application, locale } = args;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Check and write under the organisation lock (the one createPartner() and the
  // migration share), so two simultaneous submits of one address cannot both
  // pass the "no pending application" check.
  const outcome = await prisma.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const [pending, recent] = await Promise.all([
      tx.affiliateApplication.count({ where: { orgId, email: application.email, status: 'PENDING' } }),
      tx.affiliateApplication.count({ where: { orgId, email: application.email, createdAt: { gte: since } } }),
    ]);
    // One open application per address is enough for an admin to answer; a second
    // one would only be a duplicate row to reject.
    if (pending > 0) return 'pending_exists' as const;
    if (recent >= APPLICATIONS_PER_ADDRESS_PER_DAY) return 'capped' as const;
    await tx.affiliateApplication.create({
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
    return 'created' as const;
  });
  if (outcome !== 'created') return { outcome, followUp: null };
  return { outcome, followUp: () => announceApplication(orgId, application, locale) };
}

/** The admins' in-app notice and the applicant's acknowledgement. Never throws. */
async function announceApplication(orgId: string, application: AffiliateApplicationInput, locale: string | null): Promise<void> {
  // Only admins who may read the programme hear about it — a PROGRAM_ADMIN without
  // a grant gets nothing (the same rule the applications list applies), and
  // orgWhere() keeps it to this org.
  try {
    const name = `${application.firstName} ${application.lastName}`;
    const admins = await prisma.user.findMany({
      where: { AND: [{ role: 'ADMIN', isActive: true }, await orgWhere(orgId)] },
      select: { id: true, role: true, adminLevel: true, orgId: true },
    });
    for (const a of admins) {
      const actor = { id: a.id, role: a.role, adminLevel: adminTierFor(a.role, a.adminLevel), orgId: a.orgId, companyId: null };
      if (await can(actor, 'affiliate.read', { orgId })) {
        await notify(a.id, 'affiliate_application.new', { name }, '/admin/affiliates/applications');
      }
    }
  } catch (e) {
    console.error('Affiliate application notice failed:', e);
  }
  try {
    await sendAffiliateApplicationReceivedEmail({ to: application.email, firstName: application.firstName, locale, orgId });
  } catch (e) {
    console.error('Affiliate application acknowledgement failed:', e);
  }
}
