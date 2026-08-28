import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { passwordSchema } from '@/lib/password';
import { revokeAllTrustedDevices } from '@/lib/trustedDevice';

const schema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

// GET /api/auth/reset?token=... — lightweight validity check so the reset page
// can show "this link is invalid or expired" before the user types anything.
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') || '';
  const record = await prisma.passwordResetToken.findUnique({ where: { token } });
  const valid = !!record && !record.used && record.expiresAt > new Date();
  return NextResponse.json({ valid });
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'reset', { limit: 20, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Validation failed' },
        { status: 400 }
      );
    }

    const { token, password } = parsed.data;
    const record = await prisma.passwordResetToken.findUnique({ where: { token } });

    if (!record || record.used || record.expiresAt < new Date()) {
      return NextResponse.json({ error: 'This link is invalid or has expired' }, { status: 400 });
    }

    const hashed = await bcrypt.hash(password, 12);

    // Set the new password and consume the token atomically. Following the
    // emailed link proves ownership of the address, so a SET_INITIAL flow also
    // marks the email verified.
    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: {
          password: hashed,
          // Revoke every existing session (#868). A reset is what someone does
          // when they think an account is compromised; leaving the attacker's
          // 12-hour JWT alive defeated the exercise.
          sessionsValidFrom: new Date(),
          ...(record.purpose === 'SET_INITIAL' ? { emailVerified: true } : {}),
        },
      }),
      // Consume this token and every other one outstanding for the account, so
      // a second link sitting in a mailbox can't undo the reset.
      prisma.passwordResetToken.updateMany({
        where: { userId: record.userId, used: false },
        data: { used: true },
      }),
    ]);

    // Every remembered device of the account too (#1495): a reset is a
    // "lock everyone out" action, and a long-lived device cookie that survived
    // it would hand the session straight back.
    await revokeAllTrustedDevices(record.userId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Reset password error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
