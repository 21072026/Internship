import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requirePermission } from '@/lib/authz';

// DELETE — remove a source (admin). Mentees keep their record; their sourceId is
// cleared via the optional relation so no mentee is orphaned.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('user.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return await withTenantScope(session, async () => {
  const { id } = await params;
  // Same tenant only (#2570): another tenant's source answers exactly like one
  // that does not exist. It used to be deleted by id, whoever owned it.
  const source = await prisma.source.findFirst({ where: withinTenant({ id }, await tenantWhere(session)), select: { id: true } });
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.user.updateMany({ where: { sourceId: id }, data: { sourceId: null } });
  await prisma.source.delete({ where: { id } }).catch(() => null);
  await logActivity({
    action: 'source.deleted',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'source',
    targetId: id,
    request,
  });
  return NextResponse.json({ ok: true });
  });
}
