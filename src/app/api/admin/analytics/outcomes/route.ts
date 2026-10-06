import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { createSurvey, createSurveySchema } from '@/lib/surveys';
import { OUTCOME_DEFAULT_OFFSET, OUTCOME_OFFSETS, OUTCOME_TEMPLATE_KEY, outcomeSurveyInput } from '@/lib/outcomeDestination';
import { defaultOutcomePeriod, loadOutcomeReport } from '@/lib/outcomesData';

// First destination (#1912): where participants ended up after their relation
// completed. ADMIN only, tenant-scoped. GET is the report; POST sets up the
// instrument (the survey and its DAYS_AFTER_END campaign) in one call.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD — completions in that period (default:
// the last twelve months), with the knowledge rate next to every bucket and
// the response floor applied per bucket.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const period = defaultOutcomePeriod();
  const from = params.get('from');
  const to = params.get('to');
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  if (from) period.from = new Date(`${from}T00:00:00Z`);
  if (to) period.to = new Date(`${to}T23:59:59.999Z`);
  if (period.to < period.from) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  return withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const [report, setup] = await Promise.all([loadOutcomeReport(tenant, period), currentSetup(tenant)]);
    return NextResponse.json({ ...report, setup });
  });
}

/** The instrument this org already runs, if any: its survey and its campaign. */
async function currentSetup(tenant: Awaited<ReturnType<typeof tenantWhere>>) {
  const survey = await prisma.survey.findFirst({
    where: withinTenant({ templateKey: OUTCOME_TEMPLATE_KEY }, tenant),
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, campaigns: { where: { trigger: 'DAYS_AFTER_END' }, select: { id: true, dayOffset: true, active: true } } },
  });
  return survey ? { surveyId: survey.id, status: survey.status, campaigns: survey.campaigns } : null;
}

const setupSchema = z.object({ dayOffset: z.number().int().refine((n) => (OUTCOME_OFFSETS as readonly number[]).includes(n)).optional() }).strict();

// POST { dayOffset?: 30 | 90 | 180 } — create the destination survey (open)
// and a DAYS_AFTER_END campaign for it. Idempotent: an org that already has
// the survey gets it back, plus a campaign at this offset if it lacked one.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const parsed = setupSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const dayOffset = parsed.data.dayOffset ?? OUTCOME_DEFAULT_OFFSET;
  return withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const orgId = resolveOrgId(session);
    let survey = await prisma.survey.findFirst({ where: withinTenant({ templateKey: OUTCOME_TEMPLATE_KEY }, tenant), orderBy: { createdAt: 'desc' }, select: { id: true } });
    const created = !survey;
    if (!survey) {
      const made = await createSurvey(orgId, createSurveySchema.parse(outcomeSurveyInput()));
      // Open at once: the campaign only sends for a survey that accepts answers.
      await prisma.survey.update({ where: { id: made.id }, data: { status: 'OPEN' } });
      survey = { id: made.id };
    }
    const existing = await prisma.surveyCampaign.findFirst({ where: { surveyId: survey.id, trigger: 'DAYS_AFTER_END', dayOffset }, select: { id: true } });
    if (!existing) {
      await prisma.surveyCampaign.create({
        data: { orgId, surveyId: survey.id, name: `First destination · ${dayOffset} days`, trigger: 'DAYS_AFTER_END', dayOffset, audience: 'MENTEE', active: true },
      });
    }
    return NextResponse.json({ setup: await currentSetup(tenant) }, { status: created || !existing ? 201 : 200 });
  });
}

// DELETE ?userId= — a participant withdraws their destination answer (#1912,
// docs/surveys.md § Retention): every response of theirs to the destination
// survey, in this tenant, is deleted. They become eligible-and-unknown again.
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const userId = new URL(request.url).searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  return withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const { count } = await prisma.surveyResponse.deleteMany({
      where: withinTenant({ respondentId: userId, survey: { templateKey: OUTCOME_TEMPLATE_KEY } }, tenant),
    });
    if (count > 0) {
      await prisma.auditLog
        .create({ data: { actorId: session.user.id, action: 'outcome.withdraw', targetId: userId, detail: JSON.stringify({ responses: count }) } })
        .catch(() => {});
    }
    return NextResponse.json({ deleted: count });
  });
}
