// The rows behind the first-destination report (#1912) — server-only. The
// arithmetic is src/lib/outcomeDestination.ts (pure); this file decides who is
// eligible and which answer is theirs.
//
// ELIGIBLE: a mentee whose relation COMPLETED inside the period, once — a
// person with two completed relations is one participant, filed under the most
// recent one's cohort.
// THEIR ANSWER: the latest response to a survey made from the
// `outcome_destination` template, by that person. Asked again at 180 days, the
// newer answer replaces the 90-day one: the report says where people are, not
// where they were.

import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import {
  OUTCOME_TEMPLATE_KEY,
  readDestinationAnswer,
  summarizeOutcomes,
  type DestinationAnswer,
  type EligibleParticipant,
  type OutcomeSummary,
} from '@/lib/outcomeDestination';

/** The default report period: the last twelve months of completions. */
export function defaultOutcomePeriod(now = new Date()): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000), to: now };
}

export async function loadOutcomeReport(tenant: TenantWhere, period: { from: Date; to: Date }): Promise<OutcomeSummary & { from: string; to: string }> {
  const relations = await prisma.mentorshipRelation.findMany({
    where: withinTenant({ status: 'COMPLETED' as const, completedAt: { gte: period.from, lte: period.to } }, tenant),
    orderBy: { completedAt: 'desc' },
    select: { menteeId: true, cohort: { select: { name: true } }, mentee: { select: { source: { select: { name: true } } } } },
  });
  const people: EligibleParticipant[] = [];
  const seen = new Set<string>();
  for (const r of relations) {
    if (seen.has(r.menteeId)) continue;
    seen.add(r.menteeId);
    people.push({ personId: r.menteeId, cohort: r.cohort?.name ?? null, source: r.mentee.source?.name ?? null });
  }

  const answers = new Map<string, DestinationAnswer>();
  if (people.length > 0) {
    const responses = await prisma.surveyResponse.findMany({
      where: withinTenant({ respondentId: { in: [...seen] }, survey: { templateKey: OUTCOME_TEMPLATE_KEY } }, tenant),
      orderBy: { submittedAt: 'desc' },
      select: { respondentId: true, answers: { where: { questionKey: { in: ['destination', 'consent'] } }, select: { questionKey: true, value: true } } },
    });
    for (const r of responses) {
      if (!r.respondentId || answers.has(r.respondentId)) continue;
      const a = readDestinationAnswer(r.answers);
      if (a) answers.set(r.respondentId, a);
    }
  }
  return { ...summarizeOutcomes(people, answers), from: period.from.toISOString(), to: period.to.toISOString() };
}
