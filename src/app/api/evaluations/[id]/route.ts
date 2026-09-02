import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { assertSameOrg, requireOrg } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';
import { isWithinEditWindow } from '@/lib/evaluation';
import { allowedCriterionKeys } from '@/lib/evaluationTemplates';

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

// The same body shape the collection route's POST validates; the keys
// themselves are checked against the tenant's rubric inside the handler, since
// an org may have defined its own criteria (#822).
const patchSchema = z
  .object({
    scores: z.record(z.string().min(1).max(64), z.number().int().min(1).max(5)).optional(),
    comment: z.string().max(2000).optional().nullable(),
  })
  // An empty body is refused rather than treated as "correct nothing". The
  // update below un-approves and un-publishes any testimonial built on this
  // record, and that side effect must only ever fire on a real edit — a `{}`
  // PATCH would otherwise take a live public quote down while changing no
  // wording at all.
  .refine((d) => d.scores !== undefined || d.comment !== undefined, {
    message: 'Nothing to correct: send scores, comment, or both',
  });

// PATCH — correct a score or a comment inside the edit window (#1893). A typo
// used to force delete-and-rewrite, which threw the record out of its place in
// history; a bounded window makes it a correction instead. Author-only (an
// admin may also correct), and every rule below is enforced HERE — the button
// the UI hides is not a permission check.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }

    const evaluation = await prisma.evaluation.findUnique({
      where: { id },
      select: {
        id: true,
        authorId: true,
        relationId: true,
        panelId: true,
        type: true,
        createdAt: true,
        publishedAt: true,
        sharedPublicly: true,
        excerptApprovedAt: true,
        relation: { select: { orgId: true } },
      },
    });
    if (!evaluation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Evaluation is not in TENANT_MODELS, so withTenantScope does not narrow a
    // lookup by id for us — assert the tenant explicitly before authorizing, or
    // an admin of another org could correct this row once isolation is on. A
    // no-op while MT_ENFORCE_ISOLATION is off.
    assertSameOrg(evaluation.relation?.orgId ?? null, requireOrg(session));

    if (evaluation.authorId !== session.user.id && session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // An interview scorecard is not correctable through here. Its own route
    // already refuses to change a submitted one (#824): a scorecard you may
    // revise after reading the panel is not an independent signal, and this
    // window must not become the back door to that.
    if (evaluation.panelId) {
      return NextResponse.json({ error: 'Scorecards cannot be edited', code: 'panel_scorecard' }, { status: 409 });
    }

    if (!isWithinEditWindow(evaluation.createdAt)) {
      return NextResponse.json({ error: 'Edit window closed', code: 'edit_window_closed' }, { status: 409 });
    }

    if (parsed.data.scores) {
      const allowed = await allowedCriterionKeys(evaluation.relation?.orgId ?? null);
      const unknown = Object.keys(parsed.data.scores).filter((k) => !allowed.has(k));
      if (unknown.length > 0) {
        return NextResponse.json(
          { error: 'Validation failed', details: { formErrors: [`Unknown criteria: ${unknown.join(', ')}`] } },
          { status: 400 }
        );
      }
    }

    // The testimonial rule the schema already documents (#1096/#1098): the
    // author approved one exact wording, and the record that wording described
    // no longer exists — so the approval goes, and with it anything published
    // on top of it. The drafted excerpt text itself stays; re-approving it is
    // the author's call, not a retype for the admin.
    const wasPublic = !!(evaluation.excerptApprovedAt || evaluation.publishedAt || evaluation.sharedPublicly);
    const updated = await prisma.evaluation.update({
      where: { id },
      data: {
        ...(parsed.data.scores ? { scores: parsed.data.scores } : {}),
        ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment?.trim() || null } : {}),
        // The one writer of this column, which is what makes it mean
        // "corrected" and not merely "last touched" (see the schema comment).
        correctedAt: new Date(),
        excerptApprovedAt: null,
        publishedAt: null,
        sharedPublicly: false,
      },
    });
    await logActivity({
      action: 'evaluation.updated',
      actorId: session.user.id,
      actorEmail: session.user.email,
      targetType: 'Evaluation',
      targetId: evaluation.id,
      detail: `relation=${evaluation.relationId} type=${evaluation.type}${wasPublic ? ' testimonial-unpublished' : ''}`,
      request,
    });

    return NextResponse.json({
      evaluation: { id: updated.id, scores: updated.scores, comment: updated.comment, correctedAt: updated.correctedAt },
    });
  });
}
