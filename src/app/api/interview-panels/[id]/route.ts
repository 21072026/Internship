import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { criteriaByTemplate, resolveCriteria } from '@/lib/evaluationTemplates';
import { canSeeOtherScorecards, divergence, isPanelComplete, panelAverage } from '@/lib/interviewPanel';

// Panel detail — and the place blind scoring is actually enforced (#824).
//
// The response NEVER contains another interviewer's scores or comment unless
// canSeeOtherScorecards() says so. This is deliberately not a UI concern: this
// repo has already shipped a real leak by hiding data on the client instead of
// withholding it on the server (#740), and the e2e for this route asserts the
// RESPONSE BODY, not the screen.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const panel = await prisma.interviewPanel.findUnique({
      where: { id },
      include: { members: true, scorecards: true },
    });
    if (!panel) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const isAdmin = session.user.role === 'ADMIN';
    const isMember = panel.members.some((m) => m.userId === session.user.id);
    if (!isAdmin && !isMember) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const state = panel.members.map((m) => ({
      userId: m.userId,
      submittedAt: panel.scorecards.find((s) => s.authorId === m.userId)?.submittedAt ?? null,
    }));
    const complete = isPanelComplete(state, panel.closedAt);
    const reveal = canSeeOtherScorecards({
      members: state,
      closedAt: panel.closedAt,
      viewerId: session.user.id,
      viewerIsAdmin: isAdmin,
    });

    // The rubric snapshotted on the panel, or the org's current one when it
    // uses the built-ins.
    const criteria = panel.templateId
      ? (await criteriaByTemplate([panel.templateId]))[panel.templateId] ?? (await resolveCriteria(panel.orgId, 'MENTEE'))
      : await resolveCriteria(panel.orgId, 'MENTEE');

    const people = await prisma.user.findMany({
      where: { id: { in: [panel.subjectId, ...panel.members.map((m) => m.userId)] } },
      select: { id: true, fullName: true },
    });
    const nameOf = new Map(people.map((p) => [p.id, p.fullName]));

    const own = panel.scorecards.find((s) => s.authorId === session.user.id) ?? null;
    const submitted = panel.scorecards.filter((s) => s.submittedAt);

    // Who has submitted is NOT a score, and the panel cannot function without
    // it — that is how everyone knows when the collection is done.
    const roster = state.map((s) => ({
      userId: s.userId,
      name: nameOf.get(s.userId) ?? null,
      submittedAt: s.submittedAt,
      isMe: s.userId === session.user.id,
    }));

    return NextResponse.json({
      panel: {
        id: panel.id,
        title: panel.title,
        subjectId: panel.subjectId,
        subjectName: nameOf.get(panel.subjectId) ?? null,
        scheduledAt: panel.scheduledAt,
        closedAt: panel.closedAt,
        complete,
        canClose: isAdmin && !panel.closedAt,
      },
      criteria,
      roster,
      // Your own scorecard always comes back — it is yours.
      own: own ? { id: own.id, scores: own.scores, comment: own.comment, submittedAt: own.submittedAt } : null,
      // Everything below is the gated half.
      revealed: reveal,
      scorecards: reveal
        ? submitted.map((s) => ({
            authorId: s.authorId,
            authorName: nameOf.get(s.authorId) ?? null,
            scores: s.scores,
            comment: s.comment,
            submittedAt: s.submittedAt,
          }))
        : [],
      divergence: reveal
        ? divergence(
            criteria.map((c) => c.key),
            submitted.map((s) => ({ authorId: s.authorId, scores: (s.scores ?? {}) as Record<string, unknown> }))
          )
        : [],
      average: reveal ? panelAverage(submitted.map((s) => ({ scores: (s.scores ?? {}) as Record<string, unknown> }))) : null,
    });
  });
}
