import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { settingsOrgOf } from '@/lib/settingsOrg';

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'ADMIN' ? session : null;
}

// Rotate one drain's signing secret and return the new value once (#2012).
// Rotation breaks the receiver's verification until it is redeployed, so it is
// a deliberate act of its own — PATCH /api/admin/audit-drains never touches
// the secret. Same shape as webhooks/rotate-secret.
export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id') || '';
  const secret = randomBytes(24).toString('hex');
  const { count } = await prisma.auditDrain.updateMany({ where: { id, orgId: await settingsOrgOf(session) }, data: { secret } });
  if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await logActivity({
    action: 'audit_drain.secret_rotated',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'audit_drain',
    targetId: id,
    request,
  });
  return NextResponse.json({ secret });
}
