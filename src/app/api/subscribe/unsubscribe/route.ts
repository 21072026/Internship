import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { subscriberTokenHash, subscriberTokenId } from '@/lib/subscriberTokens';

// RFC 8058 clients POST without cookies. Scanners only GET: inert redirect.
export async function GET(request: Request) {
  const url = new URL(request.url);
  url.pathname = '/interest/unsubscribe';
  return NextResponse.redirect(url);
}
export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get('t') ?? '';
  const id = subscriberTokenId(token, 'unsubscribe');
  if (id) await prisma.subscriber.updateMany({
    where: { id, unsubscribeTokenHash: subscriberTokenHash(token), unsubscribedAt: null },
    data: { unsubscribedAt: new Date(), consent: false, confirmationTokenHash: null, confirmationExpiresAt: null },
  });
  return NextResponse.json({ ok: true });
}
