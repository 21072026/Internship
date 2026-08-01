import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';

// DELETE — remove an evaluation that was recorded by mistake. Only its own
// author (or an admin) may do so: an evaluation is the author's own judgement,
// so the other side of the relation cannot erase it.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const evaluation = await prisma.evaluation.findUnique({
      where: { id },
      select: { id: true, authorId: true, relationId: true, type: true },
    });
    if (!evaluation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (evaluation.authorId !== session.user.id && session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await prisma.evaluation.delete({ where: { id } });
    await logActivity({
      action: 'evaluation.deleted',
      actorId: session.user.id,
      actorEmail: session.user.email,
      targetType: 'Evaluation',
      targetId: evaluation.id,
      detail: `relation=${evaluation.relationId} type=${evaluation.type}`,
      request,
    });

    return NextResponse.json({ ok: true });
  });
}
