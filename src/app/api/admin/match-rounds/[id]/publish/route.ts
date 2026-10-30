import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { checkActiveRelationLimit, planLimitError } from '@/lib/planGate';
import { resolveStartStage } from '@/lib/pipelineStages';
import { stageTrialWindow } from '@/lib/trialWindow';
import { DEFAULT_RELATION_KIND } from '@/lib/placementKind';
import { AlreadyMentoredError } from '@/lib/activeMentorship';
import { announceNewRelation, createGuardedRelation } from '@/lib/relationCreate';
import { canTransitionRound, type RoundStatus } from '@/lib/matching/round';
import { getLocale } from '@/i18n/server';
import { scheduleCreateData } from '@/lib/relationSchedule';
import { relationScheduleDefaults } from '@/lib/relationScheduleDefaults';

// POST — publish a round (#1796): one relation per LOCKED proposal, nothing
// for a DRAFT or DISCARDED one, all inside ONE transaction — a refusal
// anywhere (the plan cap, a mentee who got a mentor elsewhere meanwhile, a
// proposal another admin unlocked) rolls the whole publish back. Never a
// half-published round. Publishing is an explicit human action: only this
// route, only from REVIEW, no schedule.
//
// It reuses the ONE create path (`src/lib/relationCreate.ts`) that a direct
// assignment uses: the guarded create inside the transaction, and after the
// commit the webhook, the MatchDecision (source BULK_ROUND, roundId, the
// proposal's own frozen score) and both sides' notices and mails.
const PARTICIPANT_ROLES = ['ADMIN', 'MENTOR', 'MENTEE'];

class PublishConflict extends Error {
  constructor(readonly code: string, readonly detail: Record<string, unknown> = {}) {
    super(code);
  }
}

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('relation.write', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const denied = await requireCapability(session.user.orgId, 'mentorship');
    if (denied) return denied;
    const { id } = await params;

    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      const round = await prisma.matchRound.findFirst({
        where: withinTenant({ id }, tenant),
        select: { id: true, status: true, orgId: true, cohortId: true, ruleSetId: true, ruleSetVersion: true },
      });
      if (!round) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (!canTransitionRound(round.status as RoundStatus, 'PUBLISHED', 'publish')) {
        return NextResponse.json({ error: 'Only a round in review can be published', code: 'round_not_in_review' }, { status: 409 });
      }

      const locked = await prisma.matchProposal.findMany({
        where: { roundId: round.id, state: 'LOCKED', mentorId: { not: null } },
        orderBy: { menteeId: 'asc' },
        select: { id: true, menteeId: true, mentorId: true, score: true, breakdown: true, blockedBy: true, note: true },
      });
      if (locked.length === 0) return NextResponse.json({ error: 'Nothing is locked', code: 'nothing_locked' }, { status: 409 });

      // The plan cap (#547) for all of them at once: refused before anything
      // is written, naming the limit.
      const plan = await checkActiveRelationLimit(round.orgId, locked.length);
      if (!plan.allowed) return NextResponse.json({ ...planLimitError(plan), needed: locked.length }, { status: 403 });

      const people = await prisma.user.findMany({
        where: withinTenant({ id: { in: [...new Set(locked.flatMap((p) => [p.menteeId, p.mentorId!]))] } }, tenant),
      });
      const byId = new Map(people.map((u) => [u.id, u]));
      const gone = locked.find((p) => {
        const mentee = byId.get(p.menteeId);
        const mentor = byId.get(p.mentorId!);
        return !mentee || !mentor || !PARTICIPANT_ROLES.includes(mentee.role) || !PARTICIPANT_ROLES.includes(mentor.role) || !mentor.isActive;
      });
      if (gone) {
        return NextResponse.json({ error: 'A locked proposal names someone who can no longer be paired', code: 'participant_gone', proposalId: gone.id }, { status: 409 });
      }

      const start = new Date();
      const pipelineStatus = await resolveStartStage(round.orgId);
      const trialWindow = await stageTrialWindow({ orgId: round.orgId, toStage: pipelineStatus, enteredAt: start });
      // A round belongs to a programme: its pairings take the programme's
      // agreed duration and rhythm (#1784), when it has defaults.
      const schedule = scheduleCreateData({}, start, await relationScheduleDefaults(round.orgId, round.cohortId));

      let created: { proposal: (typeof locked)[number]; relation: { id: string; orgId: string | null } }[];
      try {
        created = await prisma.$transaction(
          async (tx) => {
            const claimed = await tx.matchRound.updateMany({
              where: { id: round.id, status: 'REVIEW' },
              data: { status: 'PUBLISHED', publishedAt: start, publishedById: session.user.id },
            });
            if (claimed.count !== 1) throw new PublishConflict('round_conflict');
            const out: typeof created = [];
            for (const proposal of locked) {
              const mentee = byId.get(proposal.menteeId)!;
              const relation = await createGuardedRelation(tx, {
                mentorId: proposal.mentorId!,
                menteeId: proposal.menteeId,
                orgId: mentee.orgId,
                cohortId: round.cohortId,
                pipelineStatus,
                ...trialWindow,
                startDate: start,
                ...schedule,
                kind: DEFAULT_RELATION_KIND,
                funnelEnteredAt: DEFAULT_RELATION_KIND === 'PLACEMENT' ? start : null,
              });
              const sealed = await tx.matchProposal.updateMany({
                where: { id: proposal.id, state: 'LOCKED' },
                data: { state: 'PUBLISHED', relationId: relation.id, updatedById: session.user.id },
              });
              if (sealed.count !== 1) throw new PublishConflict('proposal_conflict', { proposalId: proposal.id });
              out.push({ proposal, relation: { id: relation.id, orgId: relation.orgId } });
            }
            return out;
          },
          { timeout: 60_000 },
        );
      } catch (e) {
        if (e instanceof AlreadyMentoredError) {
          return NextResponse.json(
            { error: 'A mentee in this round already has an active mentor', code: 'already_mentored', menteeId: e.menteeId },
            { status: 409 },
          );
        }
        if (e instanceof PublishConflict) {
          return NextResponse.json({ error: 'Changed meanwhile', code: e.code, ...e.detail }, { status: 409 });
        }
        throw e;
      }

      // After the commit, one pairing at a time: exactly what a direct
      // assignment does for its one pair.
      const locale = await getLocale();
      for (const { proposal, relation } of created) {
        await announceNewRelation({
          relation,
          mentor: byId.get(proposal.mentorId!)!,
          mentee: byId.get(proposal.menteeId)!,
          companyId: null,
          actor: { id: session.user.id, orgId: session.user.orgId ?? null },
          decision: {
            source: 'BULK_ROUND',
            roundId: round.id,
            note: proposal.note,
            locale,
            snapshot: {
              score: proposal.score,
              breakdown: proposal.breakdown,
              blockedBy: proposal.blockedBy,
              ruleSetId: round.ruleSetId,
              ruleSetVersion: round.ruleSetVersion,
            },
          },
        });
      }

      return NextResponse.json({
        roundId: round.id,
        published: created.length,
        relationIds: created.map((c) => c.relation.id),
      });
    });
  });
}
