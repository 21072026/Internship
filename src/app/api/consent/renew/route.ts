import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { verifyConsentRenewToken } from '@/lib/consentRenew';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';
import { logActivity } from '@/lib/activity';

// Public, token-authenticated re-consent renewal (from the retention reminder
// email). Refreshes consentAt, clears the reminder stamp and records the
// accepted privacy version. The signed token is the only credential needed.
const schema = z.object({ token: z.string().min(1) });

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const userId = verifyConsentRenewToken(parsed.data.token);
  if (!userId) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 400 });

  const now = new Date();
  await prisma.user.update({
    where: { id: userId },
    data: { consentAt: now, retentionReminderSentAt: null },
  });
  await prisma.userConsent.upsert({
    where: { userId_type: { userId, type: 'PRIVACY_POLICY' } },
    create: { userId, type: 'PRIVACY_POLICY', version: PRIVACY_POLICY_VERSION, grantedAt: now },
    update: { version: PRIVACY_POLICY_VERSION, grantedAt: now, revokedAt: null },
  });
  await logActivity({
    action: 'consent.renew',
    actorId: userId,
    actorEmail: user.email,
    targetType: 'consent',
    targetId: 'PRIVACY_POLICY',
  });

  return NextResponse.json({ ok: true });
}
