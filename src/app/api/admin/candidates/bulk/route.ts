import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { nextOnPathStatus, type PipelineStatus } from '@/lib/pipeline';
import { withTenantScope } from '@/lib/orgContext';
import { validateDropoffReason } from '@/lib/stageChange';
import { emitStageChange } from '@/lib/stageChangeEffects';
import { resolveOrgId } from '@/lib/orgScope';
import { MAX_TAGS_PER_USER } from '@/lib/tags';

const bodySchema = z.object({
  candidateIds: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(['activate', 'deactivate', 'advanceStage', 'addTag', 'removeTag']),
  // Required by addTag/removeTag (#887) and ignored by everything else.
  tagId: z.string().min(1).optional(),
});

// POST — bulk activate/deactivate/advanceStage candidates from the admin
// candidates grid (EPIC: HR bulk operations). Scoped to role MENTEE as
// defense in depth — this endpoint can never touch an admin/mentor account
// even if the caller somehow sent the wrong IDs.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { candidateIds, action } = parsed.data;

  // Bulk tagging (#887). Deliberately placed BEFORE the stage actions and
  // written as its own branch rather than woven into them: advanceStage is
  // where #740 put a real bug (raw enum index arithmetic pushing an in-progress
  // internship to "dropped"), so that code is left exactly as it is.
  if (action === 'addTag' || action === 'removeTag') {
    const tagId = parsed.data.tagId;
    if (!tagId) return NextResponse.json({ error: 'tagId is required', code: 'tag_required' }, { status: 400 });

    const orgId = resolveOrgId(session);
    const tag = await prisma.tag.findFirst({ where: { id: tagId, orgId: orgId ?? undefined }, select: { id: true, name: true } });
    if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 });

    // Same MENTEE-only scoping as the other bulk actions: a stray id can never
    // reach an admin or mentor account.
    const targets = await prisma.user.findMany({
      where: { id: { in: candidateIds }, role: 'MENTEE' },
      select: { id: true, _count: { select: { tags: true } } },
    });

    if (action === 'removeTag') {
      const { count } = await prisma.userTag.deleteMany({ where: { tagId, userId: { in: targets.map((t) => t.id) } } });
      await logActivity({
        action: 'candidates.bulk.removeTag',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'tag',
        targetId: tag.id,
        detail: `${tag.name} · ${count} people`,
        request,
      });
      return NextResponse.json({ ok: true, updated: count });
    }

    // The per-person cap is enforced here too, not just on the single-assign
    // route — a bulk action is exactly how a limit gets bypassed by accident.
    // Someone already at the cap is skipped rather than failing the whole batch.
    const existing = await prisma.userTag.findMany({
      where: { tagId, userId: { in: targets.map((t) => t.id) } },
      select: { userId: true },
    });
    const alreadyTagged = new Set(existing.map((e) => e.userId));
    const eligible = targets.filter((t) => alreadyTagged.has(t.id) || t._count.tags < MAX_TAGS_PER_USER);
    const toCreate = eligible.filter((t) => !alreadyTagged.has(t.id));

    if (toCreate.length > 0) {
      await prisma.userTag.createMany({
        data: toCreate.map((t) => ({ userId: t.id, tagId, addedById: session.user.id })),
        skipDuplicates: true,
      });
    }
    await logActivity({
      action: 'candidates.bulk.addTag',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'tag',
      targetId: tag.id,
      detail: `${tag.name} · ${toCreate.length} people`,
      request,
    });
    return NextResponse.json({
      ok: true,
      updated: toCreate.length,
      // Named explicitly so the UI can say "3 were already at the limit"
      // instead of quietly doing less than the admin asked for.
      skippedAtLimit: targets.length - eligible.length,
    });
  }

  if (action === 'activate' || action === 'deactivate') {
    const isActive = action === 'activate';
    const result = await prisma.user.updateMany({
      where: { id: { in: candidateIds }, role: 'MENTEE' },
      data: { isActive },
    });

    await logActivity({
      action: `candidates.bulk.${action}`,
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: candidateIds.join(','),
    });

    return NextResponse.json({ ok: true, updated: result.count });
  }

  if (action === 'advanceStage') {
    // Find active relations for these mentees.
    const relations = await prisma.mentorshipRelation.findMany({
      where: { menteeId: { in: candidateIds }, status: 'ACTIVE' },
      select: { id: true, menteeId: true, pipelineStatus: true, orgId: true },
    });

    let advanced = 0;
    const notifiedMentees = new Set<string>();
    for (const rel of relations) {
      // Advance along the happy path only, via nextOnPathStatus — never a raw
      // indexOf+1 on the stage list (#740). Off-path/terminal states
      // (EMPLOYED_700, INTERNSHIP_DROPPED_460, INTERNSHIP_FOUND_ELSEWHERE_800)
      // yield null and are skipped, so "advance" never bumps an in-progress
      // internship to "dropped" or an employed mentee to "found elsewhere".
      const nextStatus = nextOnPathStatus(rel.pipelineStatus);
      if (!nextStatus) continue;

      // Defense in depth (#810): "advance" only ever targets the next ON_PATH
      // key, which by construction excludes off-path/negative stages — but a
      // tenant could in principle override that key's isOffPath flag, so this
      // is still checked centrally rather than assumed. No reasonCode is
      // collected here (bulk advance has no reason UI), so this only ever
      // succeeds when the target genuinely isn't negative.
      const reasonCheck = await validateDropoffReason({ orgId: rel.orgId, toStatus: nextStatus });
      if (!reasonCheck.ok) continue;

      await prisma.$transaction([
        prisma.mentorshipRelation.update({
          where: { id: rel.id },
          data: { pipelineStatus: nextStatus },
        }),
        prisma.statusChange.create({
          data: {
            relationId: rel.id,
            fromStatus: rel.pipelineStatus as PipelineStatus,
            toStatus: nextStatus,
            changedById: session.user.id,
          },
        }),
      ]);
      // Same effects as every other stage-write path (#926/#886): one
      // notification per PERSON even if a mentee has two active relations in
      // the batch (no notification storm), webhook per relation regardless.
      await emitStageChange({
        relationId: rel.id,
        menteeId: rel.menteeId,
        orgId: rel.orgId,
        from: rel.pipelineStatus,
        to: nextStatus,
        skipNotify: notifiedMentees.has(rel.menteeId),
      });
      notifiedMentees.add(rel.menteeId);
      advanced++;
    }

    await logActivity({
      action: 'candidates.bulk.advanceStage',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: candidateIds.join(','),
    });

    return NextResponse.json({ ok: true, updated: advanced });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  });
}
