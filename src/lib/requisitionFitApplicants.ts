// The fit of a requisition's APPLICANTS (#2042) — server-only. The candidates
// who match a requisition are ranked by requisitionMatchRule.ts (#1401); the
// people who already applied are scored here with the same scoreFit(), so a
// company's board explains each applicant the same way the admin's list ranks
// a match. Nothing here filters anybody out: every applicant asked for is
// scored, whatever the result.
import { prisma } from '@/lib/prisma';
import { loadSkillEdges, skillLabels } from '@/lib/skillsResolve';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { activeRelationWhere } from '@/lib/relationLifecycle';
import { scoreFit, stageProgressOf, type FitScore } from '@/lib/matching/requisitionFit';
import type { FitReasonRole } from '@/lib/matching/fitReason';

export interface ApplicantFits {
  role: FitReasonRole;
  fits: Map<string, FitScore>;
  label: (skillId: string) => string;
}

export async function applicantFits(
  orgId: string,
  requisition: { id: string; title: string },
  menteeIds: readonly string[],
  locale: string
): Promise<ApplicantFits> {
  const req = await prisma.requisition.findFirst({
    where: { id: requisition.id, orgId },
    select: { city: true, workMode: true, skills: { select: { skillId: true, required: true } } },
  });
  const allSkillIds = req?.skills.map((s) => s.skillId) ?? [];
  const niceSkillIds = req?.skills.filter((s) => !s.required).map((s) => s.skillId) ?? [];
  const role: FitReasonRole = {
    title: requisition.title,
    requiredSkillIds: allSkillIds,
    niceSkillIds,
    remote: (req?.workMode ?? '').toLowerCase() === 'remote',
  };
  const ids = Array.from(new Set(menteeIds));
  if (ids.length === 0) return { role, fits: new Map(), label: (id) => id };

  const [people, edges, stages] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids }, orgId },
      select: {
        id: true,
        targetPosition: true,
        city: true,
        skillRows: { select: { skillId: true } },
        menteeRelations: { where: activeRelationWhere(), select: { pipelineStatus: true }, take: 1 },
      },
    }),
    loadSkillEdges(orgId, allSkillIds),
    resolvePipelineStages(orgId),
  ]);
  const required = allSkillIds.filter((id) => !niceSkillIds.includes(id));
  const fits = new Map<string, FitScore>();
  for (const p of people) {
    fits.set(
      p.id,
      scoreFit(
        { title: requisition.title, requiredSkillIds: required, niceSkillIds, city: req?.city, workMode: req?.workMode },
        {
          id: p.id,
          targetPosition: p.targetPosition,
          skillIds: p.skillRows.map((r) => r.skillId),
          city: p.city,
          stageProgress: stageProgressOf(p.menteeRelations[0]?.pipelineStatus, stages),
        },
        edges
      )
    );
  }
  const labels = await skillLabels(
    orgId,
    [...allSkillIds, ...Array.from(fits.values()).flatMap((f) => f.breakdown.flatMap((b) => b.detail))],
    locale
  );
  return { role, fits, label: (id) => labels.get(id) ?? id };
}

/** Best first by the deterministic score; ties by id, so the order is stable. */
export function rankByFit(fits: Map<string, FitScore>): string[] {
  return Array.from(fits.entries())
    .sort(([a, x], [b, y]) => y.score - x.score || (a < b ? -1 : a > b ? 1 : 0))
    .map(([id]) => id);
}
