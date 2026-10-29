import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { isLocale } from '@/i18n/config';
import { sendEmail } from '@/services/emailService';
import { logActivity } from '@/lib/activity';
import { renderNotificationEmail } from '@/lib/notifications/emailRender';
import { editableEvent, samplePayload } from '@/lib/notifications/templateAdmin';
import { BODY_MAX, SUBJECT_MAX } from '@/lib/notifications/templateRender';

// `.strict()`: a `to` (or anything else) in the body is REFUSED, not ignored.
// The address is the signed-in admin's own and nothing else — an admin screen
// that mails an arbitrary address is an open relay.
const schema = z
  .object({
    eventKey: z.string().min(1).max(96),
    locale: z.string().max(8),
    subject: z.string().max(SUBJECT_MAX).optional(),
    body: z.string().max(BODY_MAX).optional(),
  })
  .strict();

/**
 * POST — send the draft (or the stored copy) to the caller's own address
 * (#1719), rendered by the same renderNotificationEmail() a real event mail
 * uses, through sendEmail() under the `test` category (account_security, so no
 * preference silences the admin's own test), with the sample payload.
 */
export async function POST(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const def = editableEvent(parsed.data.eventKey);
  if (!def || !isLocale(parsed.data.locale)) return NextResponse.json({ error: 'Unknown event or locale' }, { status: 400 });
  const to = session.user.email;
  if (!to) return NextResponse.json({ error: 'No address on your account' }, { status: 400 });
  const { subject, body } = parsed.data;
  const orgId = await settingsOrgOf(session);
  return withTenantScope(session, async () => {
    const mail = await renderNotificationEmail({
      eventKey: def.key,
      locale: parsed.data.locale,
      orgId,
      params: samplePayload(def),
      recipientName: session.user.name ?? null,
      link: '/notifications',
      ...(subject !== undefined && body !== undefined ? { draft: { subject, body } } : {}),
    });
    const result = await sendEmail({
      to,
      userId: session.user.id,
      orgId,
      subject: mail.subject,
      html: mail.html,
      fromName: mail.fromName,
      category: 'test',
      locale: mail.locale,
    });
    await logActivity({
      action: 'notification_template.test_sent',
      actorId: session.user.id,
      actorEmail: to,
      targetType: 'NotificationTemplate',
      targetId: `${def.key}:${parsed.data.locale}`,
      request,
      orgId,
    });
    return NextResponse.json({ ok: result !== 'SKIPPED', result });
  });
}
