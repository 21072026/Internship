// Every survey of a tenant in one table (#1910) — what the XLSX "Surveys"
// sheet and the print report's survey block show. The floor rules are the
// results screen's: under a survey's floor there is no rate and no NPS, only
// the counts (src/lib/surveyResults.ts, docs/surveys.md § Results).

import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { effectiveMinResponses } from '@/lib/surveyPrivacy';
import { pickLocalized } from '@/lib/surveySchema';
import { npsFromScores } from '@/lib/nps';

/** The most recent surveys a report lists — a report is a summary, not an archive. */
export const SURVEY_OVERVIEW_LIMIT = 50;

export interface SurveyOverviewRow {
  id: string;
  title: string;
  status: string;
  anonymity: string;
  invited: number;
  responses: number;
  /** answered / invited, %; null below the floor or with nobody invited. */
  rate: number | null;
  /** The first NPS question's score; null below the floor or without one. */
  nps: number | null;
  npsN: number;
}

export async function loadSurveyOverview(tenant: TenantWhere, locale: string): Promise<SurveyOverviewRow[]> {
  const surveys = await prisma.survey.findMany({
    where: withinTenant({}, tenant),
    orderBy: { createdAt: 'desc' },
    take: SURVEY_OVERVIEW_LIMIT,
    select: {
      id: true,
      title: true,
      status: true,
      anonymity: true,
      minResponses: true,
      questions: { where: { type: 'NPS' as const }, orderBy: { sortOrder: 'asc' as const }, take: 1, select: { key: true } },
      _count: { select: { invitations: true, responses: true } },
    },
  });
  const rows: SurveyOverviewRow[] = [];
  for (const s of surveys) {
    const floor = effectiveMinResponses(s.minResponses);
    const responded = await prisma.surveyInvitation.count({ where: { surveyId: s.id, respondedAt: { not: null } } });
    const key = s.questions[0]?.key;
    const scores = key ? (await prisma.surveyAnswer.findMany({ where: { questionKey: key, response: { surveyId: s.id } }, select: { value: true } })).map((a) => a.value) : [];
    const nps = key ? npsFromScores(scores, floor) : null;
    rows.push({
      id: s.id,
      title: pickLocalized(s.title, locale),
      status: s.status,
      anonymity: s.anonymity,
      invited: s._count.invitations,
      responses: s._count.responses,
      rate: s._count.invitations > 0 && responded >= floor ? Math.round((responded / s._count.invitations) * 100) : null,
      nps: nps && !nps.suppressed ? nps.score : null,
      npsN: nps?.n ?? 0,
    });
  }
  return rows;
}
