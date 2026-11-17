import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requestHostHeader, resolvePublicInquiryTarget } from '@/lib/publicHostOrg';
import { readInquiryAttribution } from '@/lib/inquiryAttribution';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';
import { subscriberToken, subscriberTokenHash } from '@/lib/subscriberTokens';
import { sendSubscriberMail } from '@/lib/subscriberMail';

const value = z.string().max(300).optional();
const schema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
  role: z.enum(['MENTEE', 'MENTOR', 'COMPANY', 'OTHER']),
  locale: z.enum(['en', 'tr', 'de']),
  consent: z.literal(true),
  website: z.string().max(500).optional(),
  renderedAt: z.number().int(),
  utm: z.object({ source: value, medium: value, campaign: value, term: value, content: value }).optional(),
  referrer: z.string().max(2000).optional(),
});

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'subscribe', { limit: 3, windowMs: 3600000 });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const input = parsed.data;
  if (input.website || Date.now() - input.renderedAt < 3000) return NextResponse.json({ ok: true });
  const target = await resolvePublicInquiryTarget(requestHostHeader(request.headers));
  if (!target.open || !target.orgId) return NextResponse.json({ error: 'Form unavailable' }, { status: 503 });
  const id = randomUUID();
  try {
    await prisma.subscriber.create({ data: {
      id, orgId: target.orgId, email: input.email, role: input.role, locale: input.locale,
      consent: true, consentAt: new Date(), consentTextVersion: PRIVACY_POLICY_VERSION,
      confirmationTokenHash: subscriberTokenHash(subscriberToken(id, 'confirm')),
      confirmationExpiresAt: new Date(Date.now() + 7 * 86400000),
      unsubscribeTokenHash: subscriberTokenHash(subscriberToken(id, 'unsubscribe')),
      ...readInquiryAttribution(input, target.host),
    } });
  } catch (error) {
    // The unique index also handles concurrent submissions. No resend, no
    // reactivation, no replacement of somebody else's consent evidence.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return NextResponse.json({ ok: true });
    throw error;
  }
  try { await sendSubscriberMail(id, true); } catch {
    // No address/token/error payload in logs; receipt does not reveal delivery.
    console.error('Interest confirmation delivery failed');
  }
  return NextResponse.json({ ok: true });
}
