import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';

// DELETE — retire a label.
//
// This removes the TAG and the UserTag rows that point at it. It does not, and
// must not, touch the people who carried it: a label is an opinion about
// somebody, and deleting the opinion is not deleting them. The schema enforces
// the same thing (UserTag cascades from Tag; User does not).
//
// Admin-only. Creating and applying a label is everyday work a mentor should
// do; removing one from the org's whole vocabulary erases it from every person
// at once, which is an admin decision.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const orgId = resolveOrgId(session);
    // Scoped lookup, not a bare findUnique: an id from another tenant must read
    // as "not found", never as "deleted".
    const tag = await prisma.tag.findFirst({ where: { id, orgId: orgId ?? undefined }, select: { id: true, name: true } });
    if (!tag) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const removed = await prisma.userTag.count({ where: { tagId: tag.id } });
    await prisma.tag.delete({ where: { id: tag.id } });
    await logActivity({
      action: 'tag.deleted',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'tag',
      targetId: tag.id,
      detail: `${tag.name} · removed from ${removed} people`,
      request,
    });
    return NextResponse.json({ ok: true, removedFrom: removed });
  });
}
