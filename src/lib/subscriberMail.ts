import { prisma } from '@/lib/prisma';
import { runUnscoped } from '@/lib/tenantAmbient';
import { findUserInWorld, worldOfOrg } from '@/lib/userWorld';
import { sendEmail, appUrlFor, bulkListHeaders } from '@/services/emailService';
import { subscriberToken } from '@/lib/subscriberTokens';
import { emailDictionary } from '@/i18n/emailDictionary';
import { isLocale, defaultLocale } from '@/i18n/config';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Reuses the transport, suppression, queue and outbound approval infrastructure.
// No campaign scheduler or competing newsletter system is introduced here.
export async function sendSubscriberMail(id: string, confirmation = false, update?: { subject: string; text: string }) {
  const row = await runUnscoped(() => prisma.subscriber.findUnique({ where: { id } }));
  if (!row) return 'SKIPPED' as const;
  const user = await findUserInWorld(row.email, await worldOfOrg(row.orgId), { id: true });
  const locale = isLocale(row.locale) ? row.locale : defaultLocale;
  const t = (await emailDictionary(locale, row.orgId)).interest;
  const origin = await appUrlFor(row.orgId);
  const unsubscribe = `${origin}/interest/unsubscribe?t=${encodeURIComponent(subscriberToken(id, 'unsubscribe'))}`;
  const oneClick = `${origin}/api/subscribe/unsubscribe?t=${encodeURIComponent(subscriberToken(id, 'unsubscribe'))}`;
  const confirm = `${origin}/interest/confirm?t=${encodeURIComponent(subscriberToken(id, 'confirm'))}`;
  const html = confirmation
    ? `<p>${escape(t.confirmBody)}</p><p><a href="${escape(confirm)}">${escape(t.confirmButton)}</a></p>`
    : `<p>${escape(update?.text ?? '').replace(/\n/g, '<br>')}</p>`;
  const args = {
    to: row.email, orgId: row.orgId, subscriberId: id, userId: user?.id,
    subject: confirmation ? t.confirmSubject : update?.subject ?? t.title,
    html: `${html}<p><a href="${escape(unsubscribe)}">${escape(t.unsubscribe)}</a></p>`,
    locale,
    headers: { ...(confirmation ? {} : bulkListHeaders('announcements', origin)), 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
  if (confirmation) return sendEmail({ ...args, to: row.email, category: 'consent', notAfter: row.confirmationExpiresAt ?? undefined, dedupeKey: `subscriber-confirm:${id}` });
  return sendEmail({
    ...args, to: row.email, category: 'announcement',
    // no-user-row: public interest signup has no User; subscriberId gates consent and the custom footer/headers provide opt-out.
  });
}
