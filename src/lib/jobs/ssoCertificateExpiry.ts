import cron from 'node-cron';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { certificateInfo } from '@/lib/ssoMetadata';
import { daysUntil, dueWarningStage } from '@/lib/ssoCertificateRule';
import { sendSsoCertificateExpiryEmail } from '@/services/emailService';

// The `sso-certificates` job (#1933): warn an organization 30 and 7 days before
// its IdP signing certificate lapses — the day it does, nobody in the tenant
// can sign in with single sign-on.
//
// WHICH ORGS. SSO switched on, SAML, a certificate stored. A tenant that has
// not switched SSO on loses nothing on expiry, and the integration-health row
// (src/lib/integrationHealth.ts) already covers the deployment-wide view.
//
// TWO MAILS, NOT A NAG. Which mark is due is the pure rule
// (src/lib/ssoCertificateRule.ts); what was sent is persisted on the org
// (`ssoCertWarnFp` + `ssoCertWarnStage`), keyed to the certificate's
// fingerprint, so a redeploy — which restarts this process — never re-sends,
// and a new certificate starts the count afresh.
//
// CLAIM FIRST, THEN SEND — the house convention (src/lib/jobs/trialReminders.ts):
// the claim is ONE conditional updateMany on the values this tick read, so two
// overlapping ticks cannot both win a mark; a send that fails afterwards loses
// that mail rather than duplicating it, which the ladder makes affordable (the
// 7-day mail still follows a lost 30-day one).
//
// RECIPIENTS. The org's active ADMIN accounts plus its `supportEmail`, deduped.
// Explicit `orgId` on every query: there is no session here.

export interface SsoCertificateSweepResult {
  checked: number;
  warned: number;
  sent: number;
  failed: number;
}

export async function runSsoCertificateExpiry(
  opts: { orgIds?: string[]; now?: Date } = {},
): Promise<SsoCertificateSweepResult> {
  const now = opts.now ?? new Date();
  const orgs = await prisma.organization.findMany({
    where: {
      ssoEnabled: true,
      ssoProvider: 'saml',
      ssoCertificate: { not: null },
      ...(opts.orgIds ? { id: { in: opts.orgIds } } : {}),
    },
    select: {
      id: true,
      name: true,
      brandName: true,
      supportEmail: true,
      ssoCertificate: true,
      ssoCertWarnFp: true,
      ssoCertWarnStage: true,
    },
  });

  const result: SsoCertificateSweepResult = { checked: orgs.length, warned: 0, sent: 0, failed: 0 };
  for (const org of orgs) {
    const info = certificateInfo(org.ssoCertificate);
    if (!info) continue; // unparseable: the health row says so, a "will expire" mail cannot
    const daysLeft = daysUntil(info.notAfter, now);
    const stage = dueWarningStage({
      daysLeft,
      fingerprint: info.fingerprintSha256,
      sent: { fingerprint: org.ssoCertWarnFp, stage: org.ssoCertWarnStage },
    });
    if (stage === null) continue;

    const claimed = await prisma.organization.updateMany({
      where: {
        id: org.id,
        ssoCertificate: org.ssoCertificate,
        ssoCertWarnFp: org.ssoCertWarnFp,
        ssoCertWarnStage: org.ssoCertWarnStage,
      },
      data: { ssoCertWarnFp: info.fingerprintSha256, ssoCertWarnStage: stage },
    });
    if (claimed.count === 0) continue; // another tick won it, or the cert changed under us
    result.warned += 1;

    await logActivity({
      action: 'sso.certificate_expiring',
      level: 'warning',
      targetType: 'Organization',
      targetId: org.id,
      orgId: org.id,
      detail: `IdP certificate ${info.fingerprintSha256} expires ${info.notAfter.toISOString()} (${daysLeft} day(s), ${stage}-day warning)`,
    });

    const admins = await prisma.user.findMany({
      where: { orgId: org.id, role: 'ADMIN', isActive: true },
      select: { id: true, email: true, fullName: true, preferredLanguage: true },
    });
    const recipients: { to: string; fullName: string | null; locale: string | null; userId: string | null }[] =
      admins.map((a) => ({ to: a.email, fullName: a.fullName, locale: a.preferredLanguage, userId: a.id }));
    const support = org.supportEmail?.trim();
    if (support && !recipients.some((r) => r.to.toLowerCase() === support.toLowerCase())) {
      recipients.push({ to: support, fullName: null, locale: null, userId: null });
    }
    for (const r of recipients) {
      try {
        await sendSsoCertificateExpiryEmail({
          ...r,
          orgName: org.brandName || org.name,
          notAfter: info.notAfter,
          daysLeft,
          fingerprint: info.fingerprintSha256,
          orgId: org.id,
        });
        result.sent += 1;
      } catch (error) {
        result.failed += 1;
        logger.error('SSO certificate warning failed to send', { orgId: org.id, error: String(error) });
      }
    }
  }
  return result;
}

let task: cron.ScheduledTask | null = null;

/** Daily at 06:40 UTC. From /api/cron/start, never initCronJobs: this sends through emailService. */
export function initSsoCertificateExpiryCron() {
  if (task) return;
  task = cron.schedule('40 6 * * *', async () => {
    try {
      const r = await runSsoCertificateExpiry();
      if (r.warned) logger.warning('SSO certificate expiry warnings sent', { ...r });
    } catch (error) {
      logger.error('SSO certificate expiry sweep failed', { error: String(error) });
    }
  });
}
