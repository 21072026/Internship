import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { createPasswordResetToken } from '@/lib/passwordReset';
import { sendPasswordResetEmail } from '@/services/emailService';

const schema = z.object({ email: z.string().email() });

// Always responds 200 with the same body whether or not the email exists, so
// the endpoint can't be used to enumerate registered accounts.
export async function POST(request: Request) {
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (user) {
      const token = await createPasswordResetToken(user.id, 'RESET');
      try {
        await sendPasswordResetEmail({ to: user.email, token, fullName: user.fullName });
      } catch (e) {
        console.error('Password reset email failed:', e);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Forgot password error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
