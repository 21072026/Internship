import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'ADMIN' ? session : null;
}

// Rotate one webhook's signing secret and return the new value once.
// Rotation breaks the receiver's deployed verification code until it is
// redeployed, so it stays a deliberate act of its own — editing a subscription
// (PATCH /api/admin/webhooks) never touches the secret.
export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id') || '';
  const secret = randomBytes(24).toString('hex');
  const { count } = await prisma.webhook.updateMany({ where: { id }, data: { secret } });
  if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await logActivity({
    action: 'webhook.secret_rotated',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'webhook',
    targetId: id,
    request,
  });
  // Return the secret once so the receiver can verify signatures; nothing in
  // the app ever reads it back out again.
  return NextResponse.json({ secret });
}
