import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createPasswordResetToken } from '@/lib/passwordReset';
import { sendPasswordResetEmail } from '@/services/emailService';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';

// POST — admin triggers a password reset for any non-admin user: issues a
// single-use reset token and emails the user a link.
//
// The link used to come back in the response body so an admin could pass it on
// by hand when mail failed (#875). That made account takeover possible without
// any access to the target's mailbox, and put a live credential into reverse
// proxy logs, browser devtools and any screen-share. The response now reports
// only whether the mail went out; recovering from a mail failure is a mail
// problem, not a reason to hand the token to a third party.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
  const { id } = await params;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // Same rule as impersonation (`/api/admin/impersonate`): one admin must not
  // be able to take over another admin's account. Resetting a peer's password
  // is exactly that, one step removed. An admin who has genuinely lost access
  // uses the normal forgot-password flow with their own mailbox.
  if (user.role === 'ADMIN' && user.id !== session.user.id) {
    return NextResponse.json(
      { error: 'Cannot reset another admin\'s password' },
      { status: 400 }
    );
  }

  const token = await createPasswordResetToken(user.id, 'RESET');
  let emailSent = true;
  try {
    await sendPasswordResetEmail({ to: user.email, token, fullName: user.fullName, orgId: user.orgId });
  } catch (e) {
    console.error('Admin reset email failed:', e);
    emailSent = false;
  }

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: 'ADMIN_RESET_PASSWORD', targetId: user.id },
  });
  await logActivity({
    action: 'admin.reset_password',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: user.id,
    detail: emailSent ? undefined : 'reset email failed to send',
    request,
  });
  // Transparency, mirroring impersonation: the account owner hears about it.
  await notify(user.id, 'security.passwordResetStarted', {});

  return NextResponse.json({ ok: true, emailSent });
  });
}
