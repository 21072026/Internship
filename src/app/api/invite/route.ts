import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { sendInvitationEmail } from '@/services/emailService';
import { resolveOrgId } from '@/lib/orgScope';
import { z } from 'zod';
import crypto from 'crypto';

const inviteSchema = z.object({
  email: z.string().email('Invalid email'),
  role: z.enum(['MENTOR', 'MENTEE', 'ADMIN']),
});

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const parsed = inviteSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { email, role } = parsed.data;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return NextResponse.json(
        { error: 'A user with this email already exists' },
        { status: 409 }
      );
    }

    const existingToken = await prisma.invitationToken.findFirst({
      where: { email, used: false, expiresAt: { gt: new Date() } },
    });
    if (existingToken) {
      return NextResponse.json(
        { error: 'An active invitation has already been sent to this email' },
        { status: 409 }
      );
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const invitation = await prisma.invitationToken.create({
      data: {
        token,
        email,
        role,
        expiresAt,
      },
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const registerUrl = `${appUrl}/auth/register?token=${token}`;

    // The token is already persisted, so a failed/blocked email must not lose the
    // invitation — the admin can still share registerUrl manually. Report delivery
    // status instead of 500-ing.
    let emailSent = false;
    try {
      await sendInvitationEmail({ to: email, token, role, orgId: resolveOrgId(session) });
      emailSent = !!process.env.SMTP_USER;
    } catch (mailErr) {
      console.error('Invitation email failed (token still valid):', mailErr);
    }

    return NextResponse.json(
      {
        message: emailSent ? 'Invitation sent' : 'Invitation created (share the link manually)',
        invitationId: invitation.id,
        registerUrl,
        emailSent,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Invite error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const invitations = await prisma.invitationToken.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        used: true,
        createdAt: true,
        expiresAt: true,
        openedAt: true,
        registeredAt: true,
        verifiedAt: true,
      },
    });

    return NextResponse.json({ invitations });
  } catch (error) {
    console.error('Get invitations error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
