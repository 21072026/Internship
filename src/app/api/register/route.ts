import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { createEmailVerificationToken } from '@/lib/emailVerification';
import { sendVerificationEmail } from '@/services/emailService';

const registerSchema = z.object({
  token: z.string().optional(),
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  fullName: z.string().min(1, 'Full name is required'),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { token, email, password, fullName } = parsed.data;

    // With a token: validate the invitation and use its role.
    // Without a token: open self-registration as a MENTOR.
    let role: 'ADMIN' | 'MENTOR' | 'MENTEE' = 'MENTOR';

    if (token) {
      const invitation = await prisma.invitationToken.findUnique({ where: { token } });
      if (!invitation) {
        return NextResponse.json({ error: 'Invalid invitation token' }, { status: 400 });
      }
      if (invitation.used) {
        return NextResponse.json({ error: 'Invitation token has already been used' }, { status: 400 });
      }
      if (invitation.expiresAt < new Date()) {
        return NextResponse.json({ error: 'Invitation token has expired' }, { status: 400 });
      }
      if (invitation.email.toLowerCase() !== email.toLowerCase()) {
        return NextResponse.json({ error: 'Email does not match the invitation' }, { status: 400 });
      }
      role = invitation.role;
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // An invitation proves the email belongs to the registrant, so invited
    // users are verified immediately. Open (token-less) self-registration must
    // confirm the email — created unverified, then emailed a verification link.
    const emailVerified = !!token;

    const user = await prisma.user.create({
      data: { email, password: hashedPassword, fullName, role, skills: [], emailVerified },
      select: { id: true, email: true, fullName: true, role: true, createdAt: true },
    });

    if (token) {
      await prisma.invitationToken.update({ where: { token }, data: { used: true } });
    } else {
      const verifyToken = await createEmailVerificationToken(user.id);
      try {
        await sendVerificationEmail({ to: user.email, token: verifyToken, fullName: user.fullName });
      } catch (e) {
        console.error('Verification email failed:', e);
      }
    }

    return NextResponse.json({ user, emailVerified }, { status: 201 });
  } catch (error) {
    console.error('Register error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
