import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { leavePool, verifyLeaveToken } from '@/lib/reEngagement';
import { logActivity } from '@/lib/activity';

/**
 * POST — "stop writing to me", straight from the e-mail (#834).
 *
 * No session required: the signed token IS the authorisation, and demanding a
 * password before someone can stop being contacted is how you end up
 * contacting people who wanted out. A deliberate POST rather than the GET the
 * link points at, so a mail client prefetching the URL cannot act for them.
 *
 * Revokes the CONSENT, not just the date: pressing this means "not this time
 * and not next time". The person then falls back to the ordinary retention
 * policy — which was never suspended, because joining never touched it.
 */
export async function POST(request: Request) {
  const { token } = await request.json().catch(() => ({ token: '' }));
  const userId = typeof token === 'string' ? verifyLeaveToken(token) : null;
  if (!userId) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 400 });

  const person = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  // Already gone, or never there: the same answer either way. Someone pressing
  // "leave" twice should see it worked, not an error.
  if (!person) return NextResponse.json({ ok: true });

  await leavePool(person.id, { alsoRevokeConsent: true });
  await logActivity({
    action: 're_engagement.left',
    actorId: person.id,
    actorEmail: person.email,
    targetType: 'user',
    targetId: person.id,
    detail: 'via one-click link',
    request,
  });
  return NextResponse.json({ ok: true });
}
