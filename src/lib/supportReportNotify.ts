// Announcing a new bug report to the support team (#3132). The channel is the
// operator's choice (SUPPORT_REPORT_NOTIFY, see supportReportIntegrationRule.ts):
// e-mail to every active ADMIN of the reporter's org through sendEmail() —
// the one mail door — and/or one Slack incoming-webhook post. Runs after the
// response (the route calls it inside `after()`), and never throws: a mail or
// Slack outage must not lose the report that is already stored.

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { orgWhere } from '@/lib/tenantFilter';
import { assertPublicHttpsUrl } from '@/lib/ssrfGuard';
import { appUrlFor, sendSupportReportEmail } from '@/services/emailService';
import { isSlackWebhookUrl, notifyChannels, pathOnly } from '@/lib/supportReportIntegrationRule';

export async function announceSupportReport(reportId: string): Promise<void> {
  const channels = notifyChannels(process.env);
  if (channels.length === 0) return;
  const report = await prisma.supportReport.findUnique({
    where: { id: reportId },
    select: {
      id: true, orgId: true, type: true, rating: true, description: true, url: true, contactAllowed: true,
      user: { select: { fullName: true, email: true } },
    },
  });
  if (!report) return;
  const path = pathOnly(report.url).split('?')[0];

  if (channels.includes('email')) {
    const admins = await prisma.user.findMany({
      where: { AND: [{ role: 'ADMIN', isActive: true }, await orgWhere(report.orgId)] },
      select: { id: true, email: true, preferredLanguage: true },
    });
    for (const admin of admins) {
      try {
        await sendSupportReportEmail({
          to: admin.email,
          userId: admin.id,
          locale: admin.preferredLanguage,
          orgId: report.orgId,
          reportId: report.id,
          type: report.type,
          path,
          reporterName: report.user.fullName,
          reporterEmail: report.user.email,
          rating: report.rating,
          description: report.description,
          contactAllowed: report.contactAllowed,
        });
      } catch (e) {
        logger.warning('support_report.mail_failed', { reportId, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (channels.includes('slack')) {
    const hook = process.env.SUPPORT_REPORT_SLACK_WEBHOOK_URL ?? '';
    try {
      if (!isSlackWebhookUrl(hook)) throw new Error('webhook url rejected');
      await assertPublicHttpsUrl(hook);
      const link = `${await appUrlFor(report.orgId)}/admin/support/reports/${report.id}`;
      const excerpt = report.description.replace(/\s+/g, ' ').slice(0, 200);
      // Slack's escaping: & < > are the only characters it interprets.
      const slackEsc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const res = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          text: `New ${report.type === 'BUG' ? 'bug report' : 'feedback'} on ${slackEsc(path || '/')}: ${slackEsc(excerpt)} — <${link}|open>`,
        }),
      });
      if (!res.ok) throw new Error(`slack ${res.status}`);
    } catch (e) {
      logger.warning('support_report.slack_failed', { reportId, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
