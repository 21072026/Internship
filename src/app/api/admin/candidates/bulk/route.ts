import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { nextOnPathStatus } from '@/lib/pipeline';
import { withTenantScope } from '@/lib/orgContext';
import { statusChangeData, validateDropoffReason } from '@/lib/stageChange';
import { emitStageChange } from '@/lib/stageChangeEffects';
import { resolveOrgId } from '@/lib/orgScope';
import { MAX_TAGS_PER_USER } from '@/lib/tags';
import { transferMentorship } from '@/lib/mentorTransfer';
import { notify } from '@/lib/notify';

const bodySchema = z.object({
  candidateIds: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(['activate', 'deactivate', 'advanceStage', 'addTag', 'removeTag', 'assignOwner']),
  // Required by addTag/removeTag (#887) and ignored by everything else.
  tagId: z.string().min(1).optional(),
  // Required by assignOwner (#2439) and ignored by everything else. The new
  // owner is a mentor: this repo's owner column IS `MentorshipRelation.mentorId`.
  ownerId: z.string().min(1).optional(),
});

/**
 * The reason every row of a bulk owner assignment is recorded with (#2439).
 *
 * Fixed rather than taken from the request body: the bulk control exists for
 * the two cases where nobody picks a reason per person — somebody left the team
 * or a portfolio was split — and `mentor_unavailable` is precisely what that
 * means on the outgoing side. A per-row reason belongs to the single-record
 * dialog (`POST /api/mentorship/[id]/transfer`), which still offers the whole
 * vocabulary. The note below rides along into the ActivityLog entry so the
 * audit trail says which of the two paths wrote the row.
 */
const BULK_OWNER_REASON = 'mentor_unavailable' as const;

// POST — bulk activate/deactivate/advanceStage/tag/assignOwner candidates from
// the admin candidates grid (EPIC: HR bulk operations). Scoped to role MENTEE as
// defense in depth — this endpoint can never touch an admin/mentor account
// even if the caller somehow sent the wrong IDs.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // One try/catch around the whole handler, the same shape as GET /api/candidates
  // and POST /api/mentorship/[id]/transfer. It matters most for assignOwner,
  // which commits row by row: without it a throw halfway through a batch answers
  // with a bare platform 500 and the count of what DID move is never sent.
  try {
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

  // Bulk owner assignment (#2439). Its own branch, above the stage actions, for
  // the same reason bulk tagging is: this one does not touch `pipelineStatus`
  // at all, and #740 is a standing reminder to leave `advanceStage` alone.
  //
  // WHY THIS IS NOT ONE `updateMany` ON `mentorId`: changing the mentor of a
  // relation is `transferMentorship()` (#2289, docs/mentor-transfer.md). Only a
  // pairing with NO history may be re-pointed in place; one that carries any
  // work is closed ENDED_REASSIGNED and chained to a successor, because
  // `InteractionLog` has no author column and attribution runs purely through
  // `relation.mentorId` — a bulk `updateMany` would silently credit every
  // meeting the outgoing mentor ran to the incoming one, for a hundred people
  // at once. The helper also re-asks the one-active-mentor guard (#419) inside
  // its own transaction. So this loops, one relation per iteration, and is
  // deliberately slow rather than fast and wrong.
  if (action === 'assignOwner') {
    const ownerId = parsed.data.ownerId;
    if (!ownerId) return NextResponse.json({ error: 'ownerId is required', code: 'owner_required' }, { status: 400 });

    // One up-front check of the incoming owner, so a bad id answers 400 instead
    // of reporting "0 reassigned" after 200 individually-refused transfers.
    // transferMentorship re-validates it per call regardless.
    //
    // Explicitly org-scoped, exactly like the tag lookup above and for the same
    // reason: `ownerId` is an id the CLIENT chose, and this is the request that
    // moves who owns a record. The auto-scoping middleware stays dormant until
    // MT_ENFORCE_ISOLATION is on (src/lib/orgContext.ts), so "the middleware
    // will catch it" is not true today — a null orgId leaves the lookup exactly
    // as unscoped as it was, which is the single-tenant behaviour.
    const ownerOrgId = resolveOrgId(session);
    const owner = await prisma.user.findFirst({
      where: { id: ownerId, orgId: ownerOrgId ?? undefined, isActive: true, role: { in: ['ADMIN', 'MENTOR'] } },
      select: { id: true },
    });
    if (!owner) return NextResponse.json({ error: 'Invalid owner', code: 'invalid_owner' }, { status: 400 });

    // Same MENTEE-only scoping as every other branch here, and ACTIVE only:
    // ownership is a property of the live pairing. A selected candidate with no
    // live relation has no owner to change — assigning one would be creating a
    // mentorship, which is POST /api/mentorship's job and not something a
    // checkbox in a grid should do silently.
    const relations = await prisma.mentorshipRelation.findMany({
      where: { menteeId: { in: candidateIds }, status: 'ACTIVE', mentee: { role: 'MENTEE' } },
      select: { id: true, mentorId: true },
    });

    // Eligibility PER ROW, never once for the batch (the addTag branch above
    // set that precedent): one refusal — an unassignable row, a mentee who is
    // already on this owner, a pairing somebody closed while this ran — skips
    // that row and nothing else.
    //
    // `batched: true` silences the two MENTOR notices inside the helper. They
    // are sent ONCE below instead, as a count: the incoming owner is the same
    // person on every row, and a portfolio hand-over usually drains one
    // outgoing mentor as well, so the per-row shape would put up to 200
    // identical e-mails and 200 identical bell rows in front of one person.
    // Same rule, same reason, as the `notifiedMentees` set in advanceStage.
    // The MENTEE's own notice is untouched: one row, one person, one message.
    //
    // The loop is not transactional — it commits row by row — so an error is
    // caught rather than allowed to abandon the request: whatever moved before
    // it is reported and audited, because "which of my 200 moved?" is not a
    // question the admin can answer any other way. Re-running is safe (a row
    // already on this owner is skipped), so a partial batch is finishable.
    let reassigned = 0;
    const drainedFrom = new Map<string, number>();
    let partial = false;
    for (const rel of relations) {
      if (rel.mentorId === ownerId) continue;
      try {
        const result = await transferMentorship({
          relationId: rel.id,
          toMentorId: ownerId,
          reasonCode: BULK_OWNER_REASON,
          reasonNote: 'bulk owner assignment',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          request,
          batched: true,
        });
        if (result.status === 200) {
          reassigned++;
          drainedFrom.set(rel.mentorId, (drainedFrom.get(rel.mentorId) ?? 0) + 1);
        }
      } catch (e) {
        console.error('Bulk owner assignment stopped early:', e);
        partial = true;
        break;
      }
    }

    // The summary notices the per-row ones were suppressed for. Never an echo
    // to the admin who pressed the button (#886), and in-app only — mailing a
    // batch is the thing this whole shape exists to avoid.
    if (reassigned > 0 && ownerId !== session.user.id) {
      await notify(ownerId, 'mentorship.bulkAssigned', { count: reassigned }, '/mentor');
    }
    for (const [fromMentorId, count] of drainedFrom) {
      if (fromMentorId === session.user.id) continue;
      await notify(fromMentorId, 'mentorship.bulkReassignedAway', { count }, '/mentor');
    }

    await logActivity({
      action: 'candidates.bulk.assignOwner',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: ownerId,
      detail:
        `${reassigned} of ${candidateIds.length} reassigned` +
        (partial ? ' · stopped early after an error' : ''),
      request,
    });

    // `updated` is what was ACTUALLY reassigned, not what was selected — the
    // grid reports "N reassigned" from this number, so a skipped row can never
    // be read as a moved one. `partial` says the count is what got done before
    // something broke, not the whole answer.
    return NextResponse.json({
      ok: true,
      updated: reassigned,
      skipped: candidateIds.length - reassigned,
      partial,
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

      // Through the shared gate (#934) for uniformity, not because this path
      // can currently produce a no-op: `nextOnPathStatus` walks a hardcoded,
      // duplicate-free list (src/lib/pipeline.ts) and returns the NEXT element,
      // so `toStatus` can never equal `fromStatus` here, and a tenant's own
      // stage key is not on that list at all — it yields null and is dropped
      // one line above by `if (!nextStatus) continue`. The branch below is
      // therefore unreachable today; it is here so this path cannot drift from
      // the other two if the source of `nextStatus` ever changes.
      const auditRow = statusChangeData({
        relationId: rel.id,
        fromStatus: rel.pipelineStatus,
        toStatus: nextStatus,
        changedById: session.user.id,
      });
      if (!auditRow) continue;

      await prisma.$transaction([
        prisma.mentorshipRelation.update({
          where: { id: rel.id },
          data: { pipelineStatus: nextStatus },
        }),
        prisma.statusChange.create({ data: auditRow }),
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
  } catch (error) {
    console.error('Bulk candidates error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
