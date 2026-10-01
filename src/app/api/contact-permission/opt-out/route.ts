import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/lib/rateLimit';
import { verifyContactPermissionToken } from '@/lib/contactPermissionTokens';
import { optOutDoi } from '@/lib/contactPermissionDoi';

/**
 * POST — "do not e-mail me product news" (#2577), from the button on
 * /contact-permission/opt-out.
 *
 * No session, for the reason every withdrawal link in this app has none
 * (compare /api/newsletter/unsubscribe): somebody who wants out must get out in
 * one press, months later, on a phone. The signed token is the authorisation,
 * and it can do exactly one thing — withdraw. It never expires, it is
 * idempotent, and the answer is the same whether the request still exists.
 * A POST, not the GET the link points at: a link scanner must not act for
 * anyone.
 */
const schema = z.object({ token: z.string().min(1).max(512) });

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'contact-permission', { limit: 30, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const inquiryId = verifyContactPermissionToken('optout', parsed.data.token);
  if (!inquiryId) return NextResponse.json({ error: 'This link is not valid.' }, { status: 400 });

  await optOutDoi(inquiryId);
  return NextResponse.json({ ok: true });
}
