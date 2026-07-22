import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { sendInvitationEmail } from '@/services/emailService';
import { resolveOrgId } from '@/lib/orgScope';

// POST — resend an invitation. Re-emails the link; if the token has expired it
// is extended by 7 days. Used (accepted) invitations cannot be resent.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const invite = await prisma.invitationToken.findUnique({ where: { id } });
  if (!invite) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (invite.used) return NextResponse.json({ error: 'This invitation was already accepted' }, { status: 409 });

  // Refresh the expiry so a resent invite is always valid for another week.
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await prisma.invitationToken.update({ where: { id }, data: { expiresAt } });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const registerUrl = `${appUrl}/auth/register?token=${invite.token}`;
  let emailSent = false;
  try {
    await sendInvitationEmail({ to: invite.email, token: invite.token, role: invite.role, orgId: resolveOrgId(session) });
    emailSent = !!process.env.SMTP_USER;
  } catch (e) {
    console.error('Resend invitation email failed (token still valid):', e);
  }
  return NextResponse.json({ ok: true, registerUrl, emailSent });
}

// DELETE — cancel a pending invitation.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  await prisma.invitationToken.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
