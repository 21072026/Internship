// The closure report's loader and the close-loop survey's setup (#1795) —
// server-only. The arithmetic and the two rules (only COMPLETED is a success;
// scores only above the response floor) are src/lib/closureReport.ts.
//
// The close-loop survey is NOT a second survey engine: it is the
// `relation_close` template (src/lib/surveyTemplates.ts) run by a
// DAYS_AFTER_END campaign at day 0 for BOTH sides, so invitations, signed
// links, the reminder cap (src/lib/surveyReminders.ts), opt-outs and the
// CONFIDENTIAL reading rule are the engine's own. A pairing's answers are
// found through the campaign's send rows, which carry the relation.

import { prisma } from '@/lib/prisma';
import { createSurvey, createSurveySchema } from '@/lib/surveys';
import { surveyInputFromTemplate } from '@/lib/surveyTemplateInput';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { buildClosureReport, CLOSURE_TEMPLATE_KEY, type ClosureAnswer, type ClosureReport } from '@/lib/closureReport';

const ANSWER_KEYS = ['overall', 'goals_met', 'nps'];

export interface ClosureSetup {
  surveyId: string;
  status: string;
  campaignActive: boolean;
}

export async function closureSetup(tenant: TenantWhere): Promise<ClosureSetup | null> {
  const survey = await prisma.survey.findFirst({
    where: withinTenant({ templateKey: CLOSURE_TEMPLATE_KEY }, tenant),
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, campaigns: { where: { trigger: 'DAYS_AFTER_END', dayOffset: 0 }, select: { active: true } } },
  });
  return survey ? { surveyId: survey.id, status: survey.status, campaignActive: survey.campaigns.some((c) => c.active) } : null;
}

/**
 * Switch the close-loop survey on for an org: the survey from the template
 * (open at once — a campaign only sends for a survey that accepts answers) and
 * its day-0 DAYS_AFTER_END campaign for both sides. Idempotent. The engine
 * never back-fills: pairings that ended before this call are not invited.
 */
export async function setupClosureSurvey(tenant: TenantWhere, orgId: string | null): Promise<{ created: boolean }> {
  let survey = await prisma.survey.findFirst({ where: withinTenant({ templateKey: CLOSURE_TEMPLATE_KEY }, tenant), orderBy: { createdAt: 'desc' }, select: { id: true } });
  let created = false;
  if (!survey) {
    const input = surveyInputFromTemplate(CLOSURE_TEMPLATE_KEY, { audience: 'BOTH', anonymity: 'CONFIDENTIAL' })!;
    const made = await createSurvey(orgId, createSurveySchema.parse(input));
    await prisma.survey.update({ where: { id: made.id }, data: { status: 'OPEN' } });
    survey = { id: made.id };
    created = true;
  }
  const campaign = await prisma.surveyCampaign.findFirst({ where: { surveyId: survey.id, trigger: 'DAYS_AFTER_END', dayOffset: 0 }, select: { id: true } });
  if (!campaign) {
    await prisma.surveyCampaign.create({
      data: { orgId, surveyId: survey.id, name: 'Close-loop survey · at the end', trigger: 'DAYS_AFTER_END', dayOffset: 0, audience: 'BOTH', active: true },
    });
    created = true;
  }
  return { created };
}

export function defaultClosurePeriod(now = new Date()): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000), to: now };
}

/** The pairings that ended in the period, with the close-loop answers they received. */
export async function loadClosureReport(tenant: TenantWhere, period: { from: Date; to: Date }): Promise<ClosureReport & { from: string; to: string }> {
  const relations = await prisma.mentorshipRelation.findMany({
    where: withinTenant({ status: 'COMPLETED' as const, completedAt: { gte: period.from, lte: period.to } }, tenant),
    select: { id: true, lifecycleState: true, endReasonCode: true, startDate: true, completedAt: true },
    take: 5000,
  });
  const ids = relations.map((r) => r.id);
  const sends = ids.length
    ? await prisma.surveyCampaignSend.findMany({
        where: { relationId: { in: ids }, invitationId: { not: null }, campaign: { survey: withinTenant({ templateKey: CLOSURE_TEMPLATE_KEY }, tenant) } },
        select: { relationId: true, invitationId: true },
      })
    : [];
  const invitations = sends.length
    ? await prisma.surveyInvitation.findMany({
        where: { id: { in: sends.map((s) => s.invitationId!) }, respondedAt: { not: null } },
        select: { id: true, response: { select: { answers: { where: { questionKey: { in: ANSWER_KEYS } }, select: { questionKey: true, value: true } } } } },
      })
    : [];
  const answered = new Map(invitations.map((i) => [i.id, i.response?.answers ?? []]));
  const perRelation = new Map<string, { invited: number; answers: ClosureAnswer[] }>();
  for (const s of sends) {
    const entry = perRelation.get(s.relationId!) ?? { invited: 0, answers: [] };
    entry.invited += 1;
    const a = answered.get(s.invitationId!);
    if (a) {
      const value = (key: string) => a.find((x) => x.questionKey === key)?.value ?? null;
      entry.answers.push({ overall: value('overall'), goalsMet: value('goals_met'), nps: value('nps') });
    }
    perRelation.set(s.relationId!, entry);
  }
  const report = buildClosureReport(
    relations.map((r) => ({ ...r, invited: perRelation.get(r.id)?.invited ?? 0, answers: perRelation.get(r.id)?.answers ?? [] })),
  );
  return { ...report, from: period.from.toISOString(), to: period.to.toISOString() };
}
