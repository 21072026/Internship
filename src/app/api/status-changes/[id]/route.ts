import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { logActivity } from '@/lib/activity';

// DELETE — admin removes an incorrect stage-history entry.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('pipeline.transition', { request: request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  const { id } = await params;
  // StatusChange has no orgId; its tenant is its relation's. Another tenant's
  // stage-history entry reads as not found and is never deleted (#2542).
  const entry = await prisma.statusChange.findUnique({
    where: { id },
    select: { relationId: true, fromStatus: true, toStatus: true, createdAt: true, relation: { select: { orgId: true } } },
  });
  if (!entry || !(await inCallerTenant(entry.relation.orgId, resolveOrgId(session)))) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }
  try {
    await prisma.statusChange.delete({ where: { id } });
  } catch {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }
  // Deleting audit history is itself audited (#1562): every aging, conversion
  // and drop-off number is derived from these rows, so a removed one must leave
  // a trace of who removed which transition. Stage keys only — no free text.
  await logActivity({
    action: 'pipeline.history_delete',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'statusChange',
    targetId: id,
    detail: `relation ${entry.relationId}: ${entry.fromStatus} → ${entry.toStatus} (${entry.createdAt.toISOString()})`,
    orgId: entry.relation.orgId,
    request,
  });
  return NextResponse.json({ ok: true });
}
