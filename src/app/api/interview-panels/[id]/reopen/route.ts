import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';

// Reopen a panel that was closed too early (#1893) — the mirror of the close
// route, for the interviewer who turned up after the admin gave up on them.
// The panel owner or an admin may do it; idempotent on an already-open panel.
//
// Nothing here touches the blind-scoring gate, and that is deliberate. The
// detail route recomputes isPanelComplete()/canSeeOtherScorecards() from
// `closedAt` plus the live roster on EVERY read, so clearing `closedAt` re-hides
// the other scorecards from a member who has not submitted, with no extra
// logic. Do not "optimise" that into a stored "was closed, so everyone can see"
// flag: that flag is exactly the leak this route would otherwise open.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const panel = await prisma.interviewPanel.findUnique({
      where: { id },
      select: { id: true, closedAt: true, subjectId: true, createdById: true },
    });
    if (!panel) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (session.user.role !== 'ADMIN' && panel.createdById !== session.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (!panel.closedAt) return NextResponse.json({ ok: true, closedAt: null });

    await prisma.interviewPanel.update({ where: { id }, data: { closedAt: null } });
    await logActivity({
      action: 'interview_panel.reopened',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'interviewPanel',
      targetId: panel.id,
      detail: `subject=${panel.subjectId}`,
      request,
    });
    return NextResponse.json({ ok: true, closedAt: null });
  });
}
