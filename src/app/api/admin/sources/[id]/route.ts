import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

// DELETE — remove a source (admin). Mentees keep their record; their sourceId is
// cleared via the optional relation so no mentee is orphaned.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
  const { id } = await params;
  await prisma.user.updateMany({ where: { sourceId: id }, data: { sourceId: null } });
  await prisma.source.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
  });
}
