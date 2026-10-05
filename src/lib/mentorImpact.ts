// The query half of the mentor's private "your impact" card. The rule itself —
// what counts, and why nothing here ranks or rewards logging — is the header of
// src/lib/mentorImpactRule.ts (dependency-free, unit-tested).
//
// Server-only (Prisma). Read by the mentor dashboard (src/app/mentor/page.tsx).

import type { Session } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { resolvePipelineStages, outcomeStageKeysFrom } from '@/lib/pipelineStages';
import { PIPELINE_GROUPS } from '@/lib/pipeline';
import { REAL_STAGE_MOVE } from '@/lib/stageChange';
import { shellCapabilities } from '@/lib/shellCapabilities';
import type { Locale } from '@/i18n/config';
import { computeMentorImpact, internshipOrBeyondKeys, type MentorImpact } from '@/lib/mentorImpactRule';

export type { MentorImpact } from '@/lib/mentorImpactRule';

export interface MentorImpactSummary extends MentorImpact {
  /** What the tenant calls its finished stage — see `OutcomeStageKeys`. */
  finishedLabel: string;
  finishedLabelIsCustom: boolean;
}

/**
 * The signed-in mentor's own impact, or null when there is nothing honest to
 * show: no relations at all, or a vertical without the mentorship module (a
 * MARKETING MENTOR is a sales rep and the mentor layout already sends them to
 * /sales; this is the second lock, not the first).
 *
 * Only the caller's own relations (`mentorId`), only inside the caller's tenant
 * (`tenantWhere`) — the card is private by construction: there is no parameter
 * that could name another mentor.
 */
export async function getMentorImpact(session: Session, locale: Locale): Promise<MentorImpactSummary | null> {
  const orgId = resolveOrgId(session) ?? (await defaultOrgId());
  const capabilities = await shellCapabilities(orgId);
  if (!capabilities.includes('mentorship')) return null;

  const relations = await prisma.mentorshipRelation.findMany({
    where: withinTenant<Prisma.MentorshipRelationWhereInput>(
      { mentorId: session.user.id },
      await tenantWhere(session),
    ),
    select: {
      menteeId: true,
      status: true,
      pipelineStatus: true,
      // A handover successor inherits its starting stage (mentorImpactRule.ts).
      previousRelationId: true,
      // Real moves only (#2264): a no-op "move" to the same stage is not a visit.
      statusChanges: { where: REAL_STAGE_MOVE, select: { fromStatus: true, toStatus: true } },
    },
  });
  if (relations.length === 0) return null;

  const stages = await resolvePipelineStages(orgId, locale);
  const outcome = outcomeStageKeysFrom(stages);
  const internshipPhase = PIPELINE_GROUPS.find((g) => g.key === 'internship')?.statuses ?? [];

  const impact = computeMentorImpact(
    relations.map((r) => ({
      menteeId: r.menteeId,
      status: r.status,
      pipelineStatus: r.pipelineStatus,
      moves: r.statusChanges,
      startsInherited: r.previousRelationId !== null,
    })),
    { finishedKeys: outcome.finished, internshipKeys: internshipOrBeyondKeys(stages, internshipPhase) },
  );

  return {
    ...impact,
    finishedLabel: outcome.finishedLabel,
    finishedLabelIsCustom: outcome.finishedLabelIsCustom,
  };
}
