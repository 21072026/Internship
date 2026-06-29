import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { generateSecret, verifyTotp, otpauthUrl } from '@/lib/totp';
import { logActivity } from '@/lib/activity';

// GET — current 2FA status.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { twoFactorEnabled: true } });
  return NextResponse.json({ enabled: !!user?.twoFactorEnabled });
}

const schema = z.object({
  action: z.enum(['setup', 'enable', 'disable']),
  code: z.string().optional(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { action, code } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true, twoFactorSecret: true, twoFactorEnabled: true } });
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (action === 'setup') {
    // Generate (or regenerate while still disabled) a pending secret.
    const secret = generateSecret();
    await prisma.user.update({ where: { id: session.user.id }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });
    return NextResponse.json({ secret, otpauth: otpauthUrl(secret, user.email) });
  }

  if (action === 'enable') {
    if (!user.twoFactorSecret) return NextResponse.json({ error: 'Run setup first' }, { status: 400 });
    if (!code || !verifyTotp(user.twoFactorSecret, code)) {
      return NextResponse.json({ error: 'Invalid authenticator code' }, { status: 400 });
    }
    await prisma.user.update({ where: { id: session.user.id }, data: { twoFactorEnabled: true } });
    await logActivity({ action: '2fa.enable', actorId: session.user.id, actorEmail: session.user.email ?? null });
    return NextResponse.json({ enabled: true });
  }

  // disable — require a valid code to turn it off.
  if (!user.twoFactorEnabled) return NextResponse.json({ enabled: false });
  if (!user.twoFactorSecret || !code || !verifyTotp(user.twoFactorSecret, code)) {
    return NextResponse.json({ error: 'Invalid authenticator code' }, { status: 400 });
  }
  await prisma.user.update({ where: { id: session.user.id }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
  await logActivity({ action: '2fa.disable', level: 'warning', actorId: session.user.id, actorEmail: session.user.email ?? null });
  return NextResponse.json({ enabled: false });
}
