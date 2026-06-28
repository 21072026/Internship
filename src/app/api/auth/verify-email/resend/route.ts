import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createEmailVerificationToken } from '@/lib/emailVerification';
import { sendVerificationEmail } from '@/services/emailService';

// POST (authenticated) — re-send the verification email for the current user.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (user.emailVerified) {
    return NextResponse.json({ ok: true, alreadyVerified: true });
  }

  const token = await createEmailVerificationToken(user.id);
  try {
    await sendVerificationEmail({ to: user.email, token, fullName: user.fullName });
  } catch (e) {
    console.error('Resend verification email failed:', e);
  }
  return NextResponse.json({ ok: true });
}
