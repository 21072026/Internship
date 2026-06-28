import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { passwordSchema } from '@/lib/password';

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
  const limited = enforceRateLimit(request, 'reset', { limit: 10, windowMs: 15 * 60 * 1000 });
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
          ...(record.purpose === 'SET_INITIAL' ? { emailVerified: true } : {}),
        },
      }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { used: true } }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Reset password error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
