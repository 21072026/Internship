import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { isLocale } from '@/i18n/config';
import { renderNotificationEmail } from '@/lib/notifications/emailRender';
import { editableEvent, samplePayload } from '@/lib/notifications/templateAdmin';
import { BODY_MAX, SUBJECT_MAX } from '@/lib/notifications/templateRender';

const schema = z
  .object({
    eventKey: z.string().min(1).max(96),
    locale: z.string().max(8),
    // Both or neither: without a draft the preview shows what is stored now.
    subject: z.string().max(SUBJECT_MAX).optional(),
    body: z.string().max(BODY_MAX).optional(),
  })
  .strict();

/**
 * POST — the event mail exactly as it would arrive (#1719): rendered by
 * renderNotificationEmail(), the function the `notification.email` job sends
 * with, around the unsaved draft and a bracketed sample payload. Never
 * persists. The caller's org supplies the brand and the stored fallbacks.
 */
export async function POST(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const def = editableEvent(parsed.data.eventKey);
  if (!def || !isLocale(parsed.data.locale)) return NextResponse.json({ error: 'Unknown event or locale' }, { status: 400 });
  const { subject, body } = parsed.data;
  const orgId = await settingsOrgOf(gate.session);
  return withTenantScope(gate.session, async () => {
    const mail = await renderNotificationEmail({
      eventKey: def.key,
      locale: parsed.data.locale,
      orgId,
      params: samplePayload(def),
      recipientName: gate.session.user.name ?? null,
      link: '/notifications',
      ...(subject !== undefined && body !== undefined ? { draft: { subject, body } } : {}),
    });
    return NextResponse.json({ subject: mail.subject, html: mail.html, source: mail.source, fallback: mail.fallback ?? null });
  });
}
