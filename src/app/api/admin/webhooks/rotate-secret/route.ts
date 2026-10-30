import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { resolveOrgId } from '@/lib/orgScope';

// Rotate one webhook's signing secret and return the new value once.
// Rotation breaks the receiver's deployed verification code until it is
// redeployed, so it stays a deliberate act of its own — editing a subscription
// (PATCH /api/admin/webhooks) never touches the secret.
export async function POST(request: Request) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const id = new URL(request.url).searchParams.get('id') || '';
  const secret = randomBytes(24).toString('hex');
  // Scoped to the caller's tenant (#2357): rotating another tenant's signing
  // secret would silently break their receiver. Same pattern as the sibling
  // PATCH/DELETE in ../route.ts — this route binds no tenant context, so the
  // middleware never scopes it even under MT_ENFORCE_ISOLATION.
  const { count } = await prisma.webhook.updateMany({ where: { id, orgId: resolveOrgId(session) }, data: { secret } });
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
