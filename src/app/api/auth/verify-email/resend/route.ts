import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createEmailVerificationToken } from '@/lib/emailVerification';
import { sendVerificationEmail } from '@/services/emailService';
import { enforceRateLimit } from '@/lib/rateLimit';

// POST — re-send the verification email.
// - Authenticated: for the current user.
// - Public (no session): pass { email } in the body — used by the sign-in page
//   when a not-yet-verified user is locked out (e.g. their link expired). To
//   avoid leaking which emails exist, the response is always { ok: true }.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);

  let userId: string | null = null;
  if (session) {
    userId = session.user.id;
  } else {
    const limited = enforceRateLimit(request, 'verify-resend', { limit: 5, windowMs: 15 * 60 * 1000 });
    if (limited) return limited;
    const body = await request.json().catch(() => ({}));
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email) return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    // Unknown email → still return ok (no enumeration).
    userId = user?.id ?? null;
  }

  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user && !user.emailVerified) {
      const token = await createEmailVerificationToken(user.id);
      try {
        await sendVerificationEmail({ to: user.email, token, fullName: user.fullName });
      } catch (e) {
        console.error('Resend verification email failed:', e);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
