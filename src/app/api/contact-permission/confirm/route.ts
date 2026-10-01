import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/lib/rateLimit';
import { verifyContactPermissionToken } from '@/lib/contactPermissionTokens';
import { confirmDoi } from '@/lib/contactPermissionDoi';

/**
 * POST — confirm the product-news request (double opt-in, #2577), from the
 * button on /contact-permission/confirm.
 *
 * No session: the recipient of the confirmation mail is a person who filled in
 * a public form, not a user. The signed token (src/lib/contactPermissionTokens.ts)
 * is the authorisation — it was only ever delivered to the address on the
 * request, so holding it proves control of that inbox, which is exactly what a
 * double opt-in is meant to prove. A POST rather than the GET the link points
 * at, because mail scanners prefetch every URL in a message and a mutating GET
 * would confirm consents nobody gave.
 *
 * No IP address is recorded (docs/contact-permission.md § Evidence).
 */
const schema = z.object({ token: z.string().min(1).max(512) });

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'contact-permission', { limit: 30, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const inquiryId = verifyContactPermissionToken('confirm', parsed.data.token);
  if (!inquiryId) return NextResponse.json({ error: 'This link is not valid.' }, { status: 400 });

  const outcome = await confirmDoi(inquiryId);
  if (outcome.kind === 'refused') {
    // `not_found` answers like any other refusal: a valid signature on a
    // deleted enquiry says nothing a stranger could use, but there is no
    // reason to distinguish it either.
    return NextResponse.json({ code: 'not_confirmable', error: 'This request can no longer be confirmed.' }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
