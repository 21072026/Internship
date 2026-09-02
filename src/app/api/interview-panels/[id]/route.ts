import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { assertSameOrg, requireOrg } from '@/lib/orgScope';
import { criteriaByTemplate, resolveCriteria } from '@/lib/evaluationTemplates';
import { canSeeOtherScorecards, divergence, isPanelComplete, panelAverage } from '@/lib/interviewPanel';
import { blindLabel, isBlindFor } from '@/lib/blindReview';
import { getSetting } from '@/lib/settings';
import { logActivity } from '@/lib/activity';
import { notifyIfAllowed } from '@/lib/notify';
import { z } from 'zod';

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

    // Blind review (#819): while an interviewer has not committed their own
    // scores, the candidate's identity is withheld — from the RESPONSE, not
    // just from the screen. A name that reaches the browser has already done
    // its anchoring work, whatever the UI chooses to paint.
    const blind = isBlindFor({
      enabled: (await getSetting('blindReview')) === 'true',
      viewerIsMember: isMember,
      viewerSubmitted: !!own?.submittedAt,
    });

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
        // The id is withheld too: it addresses /p/<id> and the candidate page,
        // so leaving it behind would make the blinding one click deep.
        subjectId: blind ? null : panel.subjectId,
        subjectName: blind ? null : nameOf.get(panel.subjectId) ?? null,
        blind,
        blindLabel: blind ? blindLabel(panel.subjectId) : null,
        scheduledAt: panel.scheduledAt,
        closedAt: panel.closedAt,
        complete,
        canClose: isAdmin && !panel.closedAt,
        // #1893 — the two correction affordances. Both are re-checked by their
        // own routes; these flags only decide whether a button is offered.
        canEdit: (isAdmin || panel.createdById === session.user.id) && !panel.closedAt,
        canReopen: (isAdmin || panel.createdById === session.user.id) && !!panel.closedAt,
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

// Field constraints mirror the create schema on the collection route, so a
// panel cannot be edited into a shape it could not have been created in.
const patchSchema = z.object({
  title: z.string().max(160).optional().nullable(),
  scheduledAt: z.string().datetime().optional().nullable(),
  addInterviewerIds: z.array(z.string().min(1)).max(10).optional(),
  removeInterviewerIds: z.array(z.string().min(1)).max(10).optional(),
});

// PATCH — fix a panel that was convened wrong (#1893): retitle it, move it, or
// add and drop an interviewer. Only while the panel is OPEN, because changing
// the roster after the reveal would change who "everyone" was; reopen first.
// Dropping someone who already submitted is refused — their scorecard is part
// of the record, and removing them would silently rewrite the panel average.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }

    const panel = await prisma.interviewPanel.findUnique({
      where: { id },
      select: {
        id: true,
        orgId: true,
        closedAt: true,
        createdById: true,
        subjectId: true,
        members: { select: { userId: true } },
        scorecards: { select: { authorId: true, submittedAt: true } },
      },
    });
    if (!panel) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // InterviewPanel is not in TENANT_MODELS, so the lookup by id above is not
    // org-narrowed for us; assert the tenant before authorizing. No-op while
    // MT_ENFORCE_ISOLATION is off.
    assertSameOrg(panel.orgId, requireOrg(session));

    const isAdmin = session.user.role === 'ADMIN';
    if (!isAdmin && panel.createdById !== session.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (panel.closedAt) {
      return NextResponse.json({ error: 'This panel is closed', code: 'panel_closed' }, { status: 409 });
    }

    const remove = [...new Set(parsed.data.removeInterviewerIds ?? [])];
    const scored = new Set(panel.scorecards.filter((s) => s.submittedAt).map((s) => s.authorId));
    if (remove.some((userId) => scored.has(userId))) {
      return NextResponse.json({ error: 'That interviewer has already scored', code: 'already_scored' }, { status: 409 });
    }

    // Same validity filter the collection route's POST applies: a ghost member
    // would block completion for ever.
    const add = [...new Set(parsed.data.addInterviewerIds ?? [])].filter(
      (userId) => !panel.members.some((m) => m.userId === userId)
    );
    const addable = add.length
      ? await prisma.user.findMany({
          where: { id: { in: add }, isActive: true, role: { in: ['ADMIN', 'MENTOR'] } },
          select: { id: true },
        })
      : [];
    if (add.length > 0 && addable.length === 0) {
      return NextResponse.json({ error: 'No valid interviewers' }, { status: 400 });
    }

    const changed: string[] = [];
    if (parsed.data.title !== undefined || parsed.data.scheduledAt !== undefined) {
      await prisma.interviewPanel.update({
        where: { id },
        data: {
          ...(parsed.data.title !== undefined ? { title: parsed.data.title?.trim() || null } : {}),
          ...(parsed.data.scheduledAt !== undefined
            ? { scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null }
            : {}),
        },
      });
      if (parsed.data.title !== undefined) changed.push('title');
      if (parsed.data.scheduledAt !== undefined) changed.push('scheduledAt');
    }
    if (addable.length > 0) {
      await prisma.interviewPanelMember.createMany({
        data: addable.map((u) => ({ panelId: id, userId: u.id })),
        skipDuplicates: true,
      });
      // A new member now blocks completion until they submit, so they have to
      // be told — exactly as the create route tells the original roster, and
      // with the same blind-safe variant, since a notification naming the
      // candidate would undo the blinding before they open the panel (#819).
      // Without this, a late addition is the "ghost member" the validity filter
      // above exists to prevent.
      const blindEnabled = (await getSetting('blindReview')) === 'true';
      const subjectName = blindEnabled
        ? null
        : (await prisma.user.findUnique({ where: { id: panel.subjectId }, select: { fullName: true } }))?.fullName ?? '';
      await Promise.all(
        addable.map((u) =>
          blindEnabled
            ? notifyIfAllowed(u.id, 'goalsEvaluations', 'interview.assignedBlind', undefined, `/interviews/${id}`)
            : notifyIfAllowed(
                u.id,
                'goalsEvaluations',
                'interview.assigned',
                { name: subjectName ?? '' },
                `/interviews/${id}`
              )
        )
      );
      changed.push(`+${addable.length} interviewers`);
    }
    if (remove.length > 0) {
      const dropped = await prisma.interviewPanelMember.deleteMany({
        where: { panelId: id, userId: { in: remove } },
      });
      // An unsubmitted draft is left where it is rather than deleted: it counts
      // for nothing (only submitted scorecards are ever read, and completion is
      // derived from the roster), and someone removed by mistake and put back
      // finds their draft again.
      if (dropped.count > 0) changed.push(`-${dropped.count} interviewers`);
    }

    await logActivity({
      action: 'interview_panel.updated',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'interviewPanel',
      targetId: panel.id,
      detail: `subject=${panel.subjectId} changed=${changed.join(',') || 'nothing'}`,
      request,
    });
    return NextResponse.json({ ok: true, changed });
  });
}
