import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';

// Close a panel early (#824). A no-show interviewer must not be able to hold
// the calibration view hostage for ever, so an admin can end the collection —
// which reveals the scorecards that WERE submitted, and nothing else. A member
// who never submitted stays blind: otherwise "wait and read the others" would
// beat scoring.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const panel = await prisma.interviewPanel.findUnique({ where: { id }, select: { id: true, closedAt: true, subjectId: true } });
    if (!panel) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (panel.closedAt) return NextResponse.json({ ok: true, closedAt: panel.closedAt });

    const updated = await prisma.interviewPanel.update({ where: { id }, data: { closedAt: new Date() } });
    await logActivity({
      action: 'interview_panel.closed',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'interviewPanel',
      targetId: panel.id,
      detail: `subject=${panel.subjectId}`,
      request,
    });
    return NextResponse.json({ ok: true, closedAt: updated.closedAt });
  });
}
