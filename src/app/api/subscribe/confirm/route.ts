import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { subscriberTokenHash, subscriberTokenId } from '@/lib/subscriberTokens';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token : '';
  const id = subscriberTokenId(token, 'confirm');
  if (id) await prisma.subscriber.updateMany({
    where: { id, consent: true, confirmedAt: null, unsubscribedAt: null,
      confirmationTokenHash: subscriberTokenHash(token), confirmationExpiresAt: { gt: new Date() } },
    data: { confirmedAt: new Date(), confirmationTokenHash: null, confirmationExpiresAt: null },
  });
  return NextResponse.json({ ok: true });
}
