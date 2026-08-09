import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { createEmailVerificationToken } from '@/lib/emailVerification';
import { sendVerificationEmail } from '@/services/emailService';
import { accountState, canResendVerification } from '@/lib/accountState';
import { logActivity } from '@/lib/activity';

// POST — an admin re-sends the verification email for someone else (#1194).
//
// The self-service resend (`/api/auth/verify-email/resend`) only helps a user
// who comes back and tries to sign in. Someone who never got the first mail has
// no reason to return, so the admin needs to be able to push a new link from
// the user list — otherwise the account is stuck forever.
//
// Unlike the public route this reports failures honestly: the admin is the
// operator, and "we could not send it" is exactly the fact they need. There is
// no enumeration concern between admins and their own tenant's users.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        fullName: true,
        orgId: true,
        isActive: true,
        emailVerified: true,
        pendingApproval: true,
        password: true,
      },
    });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // Sending is only meaningful for an account that is waiting on a click.
    // For every other state the mail would be noise at best and misleading at
    // worst (a stand-in address on a domain that does not resolve).
    const state = accountState(user);
    if (!canResendVerification(state)) {
      return NextResponse.json(
        { error: 'This account is not waiting for email verification', accountState: state },
        { status: 409 },
      );
    }

    const token = await createEmailVerificationToken(user.id);
    try {
      await sendVerificationEmail({ to: user.email, token, fullName: user.fullName, orgId: user.orgId });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Could not send the verification email' },
        { status: 502 },
      );
    }

    await logActivity({
      action: 'user.verification_resent',
      actorId: session.user.id,
      actorEmail: session.user.email,
      targetType: 'User',
      targetId: user.id,
      request,
    });

    return NextResponse.json({ ok: true });
  });
}
