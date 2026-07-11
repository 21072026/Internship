import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { createEmailVerificationToken } from '@/lib/emailVerification';
import { sendVerificationEmail } from '@/services/emailService';
import { passwordSchema } from '@/lib/password';
import { notify } from '@/lib/notify';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';

const registerSchema = z.object({
  token: z.string().optional(),
  email: z.string().email('Invalid email'),
  password: passwordSchema,
  fullName: z.string().min(1, 'Full name is required'),
  // Consent to the privacy notice/terms. Optional for backward compatibility;
  // when sent it must be true. `privacyVersion` records which notice version
  // was shown (GDPR Art. 7 demonstrability).
  consent: z.boolean().optional(),
  privacyVersion: z.string().optional(),
});

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'register', { limit: 15, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;

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

    // If consent was explicitly provided, it must be affirmative.
    if (parsed.data.consent === false) {
      return NextResponse.json({ error: 'Consent to the privacy notice is required' }, { status: 400 });
    }

    // With a token: validate the invitation and use its role.
    // Without a token: open self-registration creates a MENTEE (#589) — mentees
    // are the self-serve intake; mentors/companies/sources arrive by invitation.
    // Same safety net as before: unverified email + inactive until admin approval.
    let role: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY' | 'SOURCE' = 'MENTEE';

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
    // Open (token-less) self-registration no longer grants immediate access:
    // the account is created inactive and must be approved by an admin. Invited
    // users (proven email + chosen role) are active right away.
    const pending = !token;

    const user = await prisma.user.create({
      data: { email, password: hashedPassword, fullName, role, skills: [], emailVerified, isActive: !pending, consentAt: new Date() },
      select: { id: true, email: true, fullName: true, role: true, createdAt: true },
    });

    // Record which privacy-notice version was accepted, so consent is auditable
    // and re-consent can be requested when the notice changes (GDPR Art. 7).
    await prisma.userConsent.create({
      data: {
        userId: user.id,
        type: 'PRIVACY_POLICY',
        version: parsed.data.privacyVersion ?? PRIVACY_POLICY_VERSION,
        grantedAt: new Date(),
      },
    });

    if (token) {
      // Advance the invitation lifecycle: registered now, and (since invited
      // users are verified immediately) verified at the same moment. openedAt is
      // backfilled in case the "opened" ping never landed (e.g. token pasted
      // manually instead of clicking the emailed link).
      const now = new Date();
      await prisma.invitationToken.update({
        where: { token },
        data: {
          used: true,
          registeredAt: now,
          verifiedAt: emailVerified ? now : undefined,
        },
      });
      // Backfill openedAt if the "opened" ping never landed (e.g. the token was
      // pasted manually instead of clicking the emailed link).
      await prisma.invitationToken.updateMany({
        where: { token, openedAt: null },
        data: { openedAt: now },
      });
    } else {
      const verifyToken = await createEmailVerificationToken(user.id);
      try {
        await sendVerificationEmail({ to: user.email, token: verifyToken, fullName: user.fullName });
      } catch (e) {
        console.error('Verification email failed:', e);
      }
      // Let admins know there's a new self-registration awaiting approval.
      const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
      await Promise.all(
        admins.map((a) => notify(a.id, 'signup', `New self-registration pending approval: ${user.fullName}.`, '/admin/users'))
      );
    }

    return NextResponse.json({ user, emailVerified, pending }, { status: 201 });
  } catch (error) {
    console.error('Register error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
