import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';

// DELETE — admin removes an incorrect stage-history entry.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  // StatusChange has no orgId; its tenant is its relation's. Another tenant's
  // stage-history entry reads as not found and is never deleted (#2542).
  const entry = await prisma.statusChange.findUnique({
    where: { id },
    select: { relation: { select: { orgId: true } } },
  });
  if (!entry || !(await inCallerTenant(entry.relation.orgId, resolveOrgId(session)))) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }
  try {
    await prisma.statusChange.delete({ where: { id } });
  } catch {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
