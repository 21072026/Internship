import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { sendEmail, verifySmtpConnection } from '@/services/emailService';
import { logActivity } from '@/lib/activity';

const schema = z.object({ to: z.string().email() });

// GET — SMTP connectivity + the addresses the app sends from, so an admin can
// confirm configuration at a glance before sending a probe.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const smtp = await verifySmtpConnection();
  return NextResponse.json({
    smtp,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || null,
    host: process.env.SMTP_HOST || null,
    inboundDomain: process.env.INBOUND_EMAIL_DOMAIN || 'crm.ersah.in',
  });
}

// POST — send a real deliverability probe to an address the admin chooses.
// Point it at a reply-based tester (e.g. check-auth@verifier.port25.com, which
// emails back an SPF/DKIM/SpamAssassin report) or a mail-tester.com address to
// diagnose the 550-5.7.26 "sender unauthenticated" (SPF/DKIM) rejections.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'A valid recipient email is required' }, { status: 400 });

  if (!process.env.SMTP_USER) {
    return NextResponse.json({ ok: false, error: 'SMTP is not configured (SMTP_USER unset).' }, { status: 200 });
  }

  const stamp = new Date().toISOString();
  try {
    await sendEmail({
      to: parsed.data.to,
      subject: `Internship CRM deliverability test — ${stamp}`,
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color:#2563eb;">Deliverability test</h2>
        <p>This is an automated test email from Internship CRM to verify outbound delivery
        and sender authentication (SPF / DKIM / DMARC).</p>
        <p style="color:#6b7280;font-size:13px;">Sent at ${stamp} from
        ${process.env.SMTP_FROM || process.env.SMTP_USER} via ${process.env.SMTP_HOST || 'the configured SMTP host'}.</p>
      </div>`,
    });
    await logActivity({
      action: 'admin.email_test',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'email',
      targetId: parsed.data.to,
    });
    return NextResponse.json({ ok: true, sentAt: stamp });
  } catch (e) {
    // Surface the SMTP error verbatim — this is the whole point of the probe.
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 200 });
  }
}
