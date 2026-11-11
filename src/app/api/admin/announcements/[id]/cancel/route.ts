import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

// POST — cancel a SCHEDULED announcement before its time (#1721). One guarded
// update: only a row still SCHEDULED moves to CANCELED, so a cancel that loses
// the race to the dispatch job (already SENDING or SENT) answers 409 and the
// announcement is treated as sent — edit or delete it like any other. The row
// is kept as a record; its queued job finds nothing to claim.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  return withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const existing = await prisma.announcement.findFirst({ where: withinTenant({ id }, tenant), select: { id: true } });
    // Another tenant's announcement answers like a missing one.
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const res = await prisma.announcement.updateMany({ where: { id, status: 'SCHEDULED' }, data: { status: 'CANCELED' } });
    if (res.count === 0) return NextResponse.json({ error: 'Not scheduled', code: 'not_scheduled' }, { status: 409 });
    await logActivity({ action: 'announcement.cancel', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'Announcement', targetId: id });
    return NextResponse.json({ canceled: true });
  });
}
