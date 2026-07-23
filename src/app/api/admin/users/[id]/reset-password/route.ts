import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createPasswordResetToken } from '@/lib/passwordReset';
import { sendPasswordResetEmail } from '@/services/emailService';
import { withTenantScope } from '@/lib/orgContext';

// POST — admin triggers a password reset for any user: issues a single-use
// reset token, emails the user a link, and returns the link so the admin can
// share it manually if email delivery fails.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const token = await createPasswordResetToken(user.id, 'RESET');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const resetUrl = `${appUrl}/auth/reset?token=${token}`;
  try {
    await sendPasswordResetEmail({ to: user.email, token, fullName: user.fullName, orgId: user.orgId });
  } catch (e) {
    console.error('Admin reset email failed:', e);
  }

  return NextResponse.json({ ok: true, resetUrl });
  });
}
