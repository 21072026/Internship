import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { settingsOrgOf } from '@/lib/settingsOrg';

// Rotate one drain's signing secret and return the new value once (#2012).
// Rotation breaks the receiver's verification until it is redeployed, so it is
// a deliberate act of its own — PATCH /api/admin/audit-drains never touches
// the secret. Same shape as webhooks/rotate-secret.
export async function POST(request: Request) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
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
