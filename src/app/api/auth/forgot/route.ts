import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { createPasswordResetToken } from '@/lib/passwordReset';
import { sendPasswordResetEmail } from '@/services/emailService';
import { isPasswordLoginBlocked } from '@/lib/ssoEnforcement';

const schema = z.object({ email: z.string().email() });

// Always responds 200 with the same body whether or not the email exists, so
// the endpoint can't be used to enumerate registered accounts.
export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'forgot', { limit: 5, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
    }

    // Normalize (trim + lowercase) so a casing/whitespace difference from what
    // was stored at registration can't silently miss the account — which would
    // otherwise show "email sent" while no reset mail is ever dispatched.
    const email = parsed.data.email.trim().toLowerCase();
    // Only the four fields the reset mail needs. This route is the escape hatch
    // when sign-in fails, so it must not share sign-in's failure modes: reading
    // the whole row means reading its `Json` columns, and one invalid value there
    // makes the read throw — inside a try/catch that answers a generic
    // "ok: true", so the reset silently never arrives and looks like an SMTP
    // problem (#1150).
    const user = await prisma.user.findUnique({
      where: { email },
      // #1720: the mail goes to an existing account, so its own stored language
      // decides. Deliberately not Accept-Language — this endpoint answers
      // identically for an address that does not exist, so the person filling in
      // the form is not necessarily the account holder.
      select: { id: true, email: true, fullName: true, orgId: true, ssoExempt: true, preferredLanguage: true },
    });
    // Enforced SSO (#1950): the reset endpoint refuses to complete for this
    // tenant, so mailing the link would only hand someone a dead end. Skipped
    // silently — the response below is identical either way, which is the whole
    // point of this endpoint and must not become an enumeration oracle here.
    const ssoBlocked = user ? await isPasswordLoginBlocked(user) : false;
    if (user && !ssoBlocked) {
      const token = await createPasswordResetToken(user.id, 'RESET');
      try {
        await sendPasswordResetEmail({
          to: user.email,
          token,
          fullName: user.fullName,
          orgId: user.orgId,
          locale: user.preferredLanguage,
        });
      } catch (e) {
        console.error('Password reset email failed:', e);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Forgot password error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
