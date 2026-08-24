import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { z } from 'zod';
import { allowedCriterionKeys } from '@/lib/evaluationTemplates';
import { isPanelComplete } from '@/lib/interviewPanel';
import { notifyIfAllowed } from '@/lib/notify';
import { dispatchWebhook } from '@/lib/webhooks';

// An interviewer's own scorecard (#824).
//
// Saving without `submit` keeps it a draft — invisible to everyone else and not
// counted towards panel completion. Submitting commits it: from then on it can
// no longer be edited, because a scorecard you can revise after reading the
// others is not an independent one.
const schema = z.object({
  scores: z.record(z.string().min(1).max(64), z.number().int().min(1).max(5)),
  comment: z.string().max(2000).optional().nullable(),
  submit: z.boolean().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }

    const panel = await prisma.interviewPanel.findUnique({
      where: { id },
      include: { members: true, scorecards: { select: { id: true, authorId: true, submittedAt: true } } },
    });
    if (!panel) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // Only an assigned interviewer scores. An admin who is not on the panel
    // runs the calibration; they do not get to add a voice to it.
    if (!panel.members.some((m) => m.userId === session.user.id)) {
      return NextResponse.json({ error: 'Not on this panel' }, { status: 403 });
    }
    if (panel.closedAt) return NextResponse.json({ error: 'This panel is closed' }, { status: 409 });

    const existing = panel.scorecards.find((s) => s.authorId === session.user.id);
    if (existing?.submittedAt) {
      return NextResponse.json({ error: 'Your scorecard is already submitted', code: 'already_submitted' }, { status: 409 });
    }

    const allowed = await allowedCriterionKeys(panel.orgId);
    const unknown = Object.keys(parsed.data.scores).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: 'Validation failed', details: { formErrors: [`Unknown criteria: ${unknown.join(', ')}`] } },
        { status: 400 }
      );
    }

    const submittedAt = parsed.data.submit ? new Date() : null;
    const data = {
      scores: parsed.data.scores,
      comment: parsed.data.comment?.trim() || null,
      submittedAt,
    };

    const scorecard = existing
      ? await prisma.evaluation.update({ where: { id: existing.id }, data })
      : await prisma.evaluation.create({
          data: {
            ...data,
            authorId: session.user.id,
            type: 'INTERVIEW',
            panelId: panel.id,
            subjectId: panel.subjectId,
            templateId: panel.templateId,
          },
        });

    if (submittedAt) {
      const state = panel.members.map((m) => ({
        userId: m.userId,
        submittedAt:
          m.userId === session.user.id
            ? submittedAt
            : panel.scorecards.find((s) => s.authorId === m.userId)?.submittedAt ?? null,
      }));
      if (isPanelComplete(state, panel.closedAt)) {
        await dispatchWebhook('interview_panel.completed', { panelId: panel.id, subjectId: panel.subjectId });
        // Everyone who scored now has something to compare against, and the
        // person who convened the panel has a decision to make.
        const audience = new Set([...panel.members.map((m) => m.userId), panel.createdById].filter(Boolean) as string[]);
        await Promise.all(
          [...audience].map((userId) =>
            notifyIfAllowed(userId, 'goalsEvaluations', 'interview.panelComplete', {}, `/interviews/${panel.id}`)
          )
        );
      }
    }

    return NextResponse.json({ ok: true, submitted: !!submittedAt, scorecardId: scorecard.id }, { status: 201 });
  });
}
