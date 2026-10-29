import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { requireCapability } from '@/lib/capabilityGate';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { emit } from '@/lib/events/emit';
import { isPanelComplete } from '@/lib/interviewPanel';
import { requirePermission } from '@/lib/authz';

// Close a panel early (#824). A no-show interviewer must not be able to hold
// the calibration view hostage for ever, so an admin can end the collection —
// which reveals the scorecards that WERE submitted, and nothing else. A member
// who never submitted stays blind: otherwise "wait and read the others" would
// beat scoring.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Placement write (#2364), gated before the role check like every other
  // handler of the module.
  const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return capGate;
  const gate = await requirePermission('company.write', { request });
  if ('error' in gate) return gate.error;

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const panel = await prisma.interviewPanel.findUnique({
      where: { id },
      select: {
        id: true, closedAt: true, subjectId: true,
        members: { select: { userId: true } },
        scorecards: { select: { authorId: true, submittedAt: true } },
      },
    });
    if (!panel) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (panel.closedAt) return NextResponse.json({ ok: true, closedAt: panel.closedAt });

    // Guarded on "still open" so two racing closes raise one
    // `interview_panel.completed` (#1998), not two.
    const closedAt = new Date();
    const changed = await prisma.interviewPanel.updateMany({ where: { id, closedAt: null }, data: { closedAt } });
    if (changed.count !== 1) {
      const now = await prisma.interviewPanel.findUnique({ where: { id }, select: { closedAt: true } });
      return NextResponse.json({ ok: true, closedAt: now?.closedAt ?? closedAt });
    }
    await logActivity({
      action: 'interview_panel.closed',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'interviewPanel',
      targetId: panel.id,
      detail: `subject=${panel.subjectId}`,
      request,
    });
    // The other half of "every interviewer scored, or an admin closed it" —
    // the score route raises the first, so a panel everybody had already
    // scored is not announced twice.
    const everyoneScored = isPanelComplete(
      panel.members.map((m) => ({ userId: m.userId, submittedAt: panel.scorecards.find((s) => s.authorId === m.userId)?.submittedAt ?? null })),
      null,
    );
    if (!everyoneScored) await emit('interview_panel.completed', { panelId: panel.id, subjectId: panel.subjectId }, { orgId: session.user.orgId ?? null, actor: { id: session.user.id, type: 'user' } });
    return NextResponse.json({ ok: true, closedAt });
  });
}
