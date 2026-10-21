import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { nextOnPathStage, type ResolvedStage } from '@/lib/pipeline';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { recordStageMove, stageMoveData } from '@/lib/stageMove';
import { withTenantScope } from '@/lib/orgContext';
import { statusChangeData, validateDropoffReason } from '@/lib/stageChange';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
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
  // Every id below comes from the client and the tenant middleware is dormant
  // (MT_ENFORCE_ISOLATION off), so every lookup and every write is narrowed to
  // the caller's tenant by hand (#2542 follow-up). A foreign id is skipped
  // exactly like an id that does not exist. A session without an org is the
  // default org's — the old `orgId ?? undefined` read it as unscoped.
  const tenant = await tenantWhere(session);

  // Bulk tagging (#887). Deliberately placed BEFORE the stage actions and
  // written as its own branch rather than woven into them: advanceStage is
  // where #740 put a real bug (raw enum index arithmetic pushing an in-progress
  // internship to "dropped"), so that code is left exactly as it is.
  if (action === 'addTag' || action === 'removeTag') {
    const tagId = parsed.data.tagId;
    if (!tagId) return NextResponse.json({ error: 'tagId is required', code: 'tag_required' }, { status: 400 });

    // Tag.orgId is NOT NULL, so the default org's `orgId IS NULL` arm of the
    // tenant fragment is not a valid Tag filter (Prisma: "Argument `orgId` is
    // missing" → 500). Match the caller's org id exactly, like /api/tags/assign.
    const tagOrgId = resolveOrgId(session) ?? (await defaultOrgId());
    const tag = await prisma.tag.findFirst({ where: { id: tagId, orgId: tagOrgId }, select: { id: true, name: true } });
    if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 });

    // Same MENTEE-only scoping as the other bulk actions: a stray id can never
    // reach an admin or mentor account.
    const targets = await prisma.user.findMany({
      where: withinTenant({ id: { in: candidateIds }, role: 'MENTEE' as const }, tenant),
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
    // will catch it" is not true today. A session without an org is the
    // default org's (`tenantWhere`), never unscoped.
    const owner = await prisma.user.findFirst({
      where: withinTenant({ id: ownerId, isActive: true, role: { in: ['ADMIN' as const, 'MENTOR' as const] } }, tenant),
      select: { id: true },
    });
    if (!owner) return NextResponse.json({ error: 'Invalid owner', code: 'invalid_owner' }, { status: 400 });

    // Same MENTEE-only scoping as every other branch here, and ACTIVE only:
    // ownership is a property of the live pairing. A selected candidate with no
    // live relation has no owner to change — assigning one would be creating a
    // mentorship, which is POST /api/mentorship's job and not something a
    // checkbox in a grid should do silently.
    const relations = await prisma.mentorshipRelation.findMany({
      where: withinTenant({ menteeId: { in: candidateIds }, status: 'ACTIVE' as const, mentee: { role: 'MENTEE' as const } }, tenant),
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
          callerOrgId: session.user.orgId,
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
      where: withinTenant({ id: { in: candidateIds }, role: 'MENTEE' as const }, tenant),
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
      where: withinTenant({ menteeId: { in: candidateIds }, status: 'ACTIVE' as const }, tenant),
      select: { id: true, menteeId: true, pipelineStatus: true, orgId: true, trialStartedAt: true, trialEndsAt: true },
    });

    // The RESOLVED stage order of each relation's own org (#1637), not the
    // canonical constant: on a custom pipeline `nextOnPathStatus()` knew no key
    // at all, so every row was skipped while the response still read as a
    // success. Resolved once per org for the batch; the relation's orgId
    // decides, as every other stage-write path does.
    const stagesByOrg = new Map<string, Promise<ResolvedStage[]>>();
    const stagesOf = (orgId: string | null) => {
      const key = orgId ?? '';
      let hit = stagesByOrg.get(key);
      if (!hit) {
        hit = resolvePipelineStages(orgId);
        stagesByOrg.set(key, hit);
      }
      return hit;
    };

    let advanced = 0;
    // Why each relation that did not move stayed where it was — the screen says
    // "3 advanced, 2 already at the final stage" rather than claiming them all.
    const reasons: Record<string, number> = {};
    const skip = (reason: string) => {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    };
    const withRelation = new Set(relations.map((r) => r.menteeId));
    for (const id of new Set(candidateIds)) if (!withRelation.has(id)) skip('no_active_relation');

    const notifiedMentees = new Set<string>();
    for (const rel of relations) {
      // Advance along the happy path only — the next ON-PATH key of the
      // tenant's order, never a raw indexOf+1 on the stage list (#740). An
      // off-path or terminal current stage, or the last on-path one, stays put.
      const next = nextOnPathStage(await stagesOf(rel.orgId), rel.pipelineStatus);
      if ('skip' in next) {
        skip(next.skip);
        continue;
      }
      const nextStatus = next.to;

      // Defense in depth (#810): "advance" only ever targets the next ON_PATH
      // key, which by construction excludes off-path/negative stages — but a
      // tenant could in principle override that key's isOffPath flag, so this
      // is still checked centrally rather than assumed. No reasonCode is
      // collected here (bulk advance has no reason UI), so this only ever
      // succeeds when the target genuinely isn't negative.
      const reasonCheck = await validateDropoffReason({ orgId: rel.orgId, toStatus: nextStatus });
      if (!reasonCheck.ok) {
        skip('needs_reason');
        continue;
      }

      // The shared no-op gate (#934): `nextOnPathStage` returns a DIFFERENT key
      // by construction, so this cannot trip today; it is here so this path
      // cannot drift from the others if the source of `nextStatus` changes.
      const auditRow = statusChangeData({
        relationId: rel.id,
        fromStatus: rel.pipelineStatus,
        toStatus: nextStatus,
        changedById: session.user.id,
      });
      if (!auditRow) {
        skip('final_stage');
        continue;
      }

      // The shared stage write path (#2658): the columns from stageMoveData()
      // (stage + the trial window, #2551), the history row in the same
      // transaction, then recordStageMove() for the activity line and the
      // effects — notification, webhook, SLA deadline and breach (#926/#817).
      const data = await stageMoveData(rel, nextStatus);
      await prisma.$transaction([
        prisma.mentorshipRelation.update({ where: { id: rel.id }, data }),
        prisma.statusChange.create({ data: auditRow }),
      ]);
      // One notification per PERSON even if a mentee has two active relations
      // in the batch (no notification storm), webhook per relation regardless.
      await recordStageMove({
        relation: rel,
        toStatus: nextStatus,
        actor: { id: session.user.id, email: session.user.email },
        historyWritten: true,
        skipNotify: notifiedMentees.has(rel.menteeId),
      });
      notifiedMentees.add(rel.menteeId);
      advanced++;
    }

    const skipped = Object.values(reasons).reduce((n, c) => n + c, 0);
    await logActivity({
      action: 'candidates.bulk.advanceStage',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: candidateIds.join(','),
      detail: `${advanced} advanced, ${skipped} skipped`,
    });

    // `updated` stays (= advanced) for the callers that read it.
    return NextResponse.json({ ok: true, updated: advanced, advanced, skipped, reasons });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  });
  } catch (error) {
    console.error('Bulk candidates error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
