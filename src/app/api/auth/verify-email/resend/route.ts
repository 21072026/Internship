import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createEmailVerificationToken } from '@/lib/emailVerification';
import { sendVerificationEmail } from '@/services/emailService';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withTenantScope } from '@/lib/orgContext';

// POST — re-send the verification email.
// - Authenticated: for the current user. The caller already proved who they
//   are by signing in, so there's no enumeration risk — a real send failure
//   (e.g. SMTP down) is surfaced instead of a false "sent" response (#483).
// - Public (no session): pass { email } in the body — used by the sign-in page
//   when a not-yet-verified user is locked out (e.g. their link expired). To
//   avoid leaking which emails exist, the response is always { ok: true }
//   regardless of whether the email exists or the send succeeds.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);

  if (session) {
    return await withTenantScope(session, async () => {
    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (user.emailVerified) return NextResponse.json({ ok: true, alreadyVerified: true });

    const token = await createEmailVerificationToken(user.id);
    try {
      await sendVerificationEmail({ to: user.email, token, fullName: user.fullName, orgId: user.orgId });
    } catch (e) {
      console.error('Resend verification email failed:', e);
      return NextResponse.json({ error: 'Could not send the verification email. Please try again shortly.' }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
    });
  }

  const limited = enforceRateLimit(request, 'verify-resend', { limit: 5, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) return NextResponse.json({ error: 'Email is required' }, { status: 400 });
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && !user.emailVerified) {
    const token = await createEmailVerificationToken(user.id);
    try {
      await sendVerificationEmail({ to: user.email, token, fullName: user.fullName, orgId: user.orgId });
    } catch (e) {
      console.error('Resend verification email failed (public path):', e);
    }
  }
  // Unknown email or already verified → still return ok (no enumeration).
  return NextResponse.json({ ok: true });
}
