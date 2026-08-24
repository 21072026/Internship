import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';
import { notifyIfAllowed } from '@/lib/notify';
import { resolveTemplateId } from '@/lib/evaluationTemplates';
import { getSetting } from '@/lib/settings';
import { isPanelComplete } from '@/lib/interviewPanel';
import { blindLabel, isBlindFor } from '@/lib/blindReview';

// Interview panels (#824). An admin (or a mentor running the round) assigns a
// candidate, a rubric and N interviewers; each scores independently.

const createSchema = z.object({
  subjectId: z.string().min(1),
  interviewerIds: z.array(z.string().min(1)).min(1).max(10),
  title: z.string().max(160).optional().nullable(),
  scheduledAt: z.string().datetime().optional().nullable(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { subjectId, interviewerIds } = parsed.data;

    const subject = await prisma.user.findUnique({ where: { id: subjectId }, select: { id: true, orgId: true, fullName: true } });
    if (!subject) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 });

    // Everyone on the panel has to be a real, active account that can actually
    // sign in and score — a ghost member would block completion for ever.
    const interviewers = await prisma.user.findMany({
      where: { id: { in: [...new Set(interviewerIds)] }, isActive: true, role: { in: ['ADMIN', 'MENTOR'] } },
      select: { id: true, fullName: true },
    });
    if (interviewers.length === 0) {
      return NextResponse.json({ error: 'No valid interviewers' }, { status: 400 });
    }

    const orgId = subject.orgId ?? resolveOrgId(session);
    const panel = await prisma.interviewPanel.create({
      data: {
        orgId,
        subjectId,
        title: parsed.data.title?.trim() || null,
        scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
        createdById: session.user.id,
        // The rubric is snapshotted at creation so a mid-round change to the
        // org's framework cannot make two interviewers score different things.
        templateId: await resolveTemplateId(orgId, 'MENTEE'),
        members: { create: interviewers.map((i) => ({ userId: i.id })) },
      },
      include: { members: true },
    });

    // Under blind review the assignment notification must not name the
    // candidate either — a push notification that says who it is undoes the
    // blinding before the interviewer even opens the panel (#819).
    const blindEnabled = (await getSetting('blindReview')) === 'true';
    await Promise.all(
      interviewers.map((i) =>
        blindEnabled
          ? notifyIfAllowed(i.id, 'goalsEvaluations', 'interview.assignedBlind', undefined, `/interviews/${panel.id}`)
          : notifyIfAllowed(i.id, 'goalsEvaluations', 'interview.assigned', { name: subject.fullName }, `/interviews/${panel.id}`)
      )
    );
    await logActivity({
      action: 'interview_panel.created',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'interviewPanel',
      targetId: panel.id,
      detail: `${subject.fullName} · ${interviewers.length} interviewers`,
      request,
    });

    return NextResponse.json({ panel: { id: panel.id } }, { status: 201 });
  });
}

// GET — panels the caller may see: an admin sees the org's, everyone else sees
// the ones they are on. Never includes anyone's scores; that is the detail
// route's job, behind the blind-scoring gate.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const subjectId = new URL(request.url).searchParams.get('subjectId');
    const isAdmin = session.user.role === 'ADMIN';
    const panels = await prisma.interviewPanel.findMany({
      where: {
        ...(subjectId ? { subjectId } : {}),
        ...(isAdmin ? {} : { members: { some: { userId: session.user.id } } }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        members: true,
        scorecards: { select: { authorId: true, submittedAt: true } },
      },
    });

    const subjects = await prisma.user.findMany({
      where: { id: { in: panels.map((p) => p.subjectId) } },
      select: { id: true, fullName: true },
    });
    const nameOf = new Map(subjects.map((s) => [s.id, s.fullName]));
    // Blind review (#819) applies to the list too — a name withheld on the
    // detail page but printed in the list next to it is not withheld.
    const blindEnabled = (await getSetting('blindReview')) === 'true';

    return NextResponse.json({
      panels: panels.map((p) => {
        const state = p.members.map((m) => ({
          userId: m.userId,
          submittedAt: p.scorecards.find((s) => s.authorId === m.userId)?.submittedAt ?? null,
        }));
        const me = state.find((s) => s.userId === session.user.id);
        const blind = isBlindFor({
          enabled: blindEnabled,
          viewerIsMember: !!me,
          viewerSubmitted: !!me?.submittedAt,
        });
        return {
          id: p.id,
          title: p.title,
          subjectId: blind ? null : p.subjectId,
          subjectName: blind ? null : nameOf.get(p.subjectId) ?? null,
          blind,
          blindLabel: blind ? blindLabel(p.subjectId) : null,
          scheduledAt: p.scheduledAt,
          closedAt: p.closedAt,
          createdAt: p.createdAt,
          memberCount: state.length,
          submittedCount: state.filter((s) => s.submittedAt).length,
          complete: isPanelComplete(state, p.closedAt),
          mine: state.some((s) => s.userId === session.user.id),
          iSubmitted: !!state.find((s) => s.userId === session.user.id)?.submittedAt,
        };
      }),
    });
  });
}
