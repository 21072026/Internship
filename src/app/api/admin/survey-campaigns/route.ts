import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SurveyAudience, SurveyTrigger } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { requirePermission } from '@/lib/authz';

// Survey campaigns (#1887): who gets which survey, when. The sweep that acts on
// them is src/lib/surveyCampaigns.ts. A stage trigger is checked against the
// tenant's OWN stage set here, so a campaign can never name a key the org does
// not have (which would silently never fire).

const TRIGGERS = ['STAGE_ENTERED', 'DAYS_AFTER_START', 'DAYS_BEFORE_END', 'DAYS_AFTER_END', 'RECURRING', 'MANUAL'] as const;
const AUDIENCES = ['MENTEE', 'MENTOR', 'BOTH'] as const;
const oneOf = <T extends readonly string[]>(values: T) => z.string().refine((v): v is T[number] => (values as readonly string[]).includes(v), 'not allowed');

const createSchema = z
  .object({
    surveyId: z.string().min(1).max(60),
    name: z.string().trim().min(1).max(120),
    trigger: oneOf(TRIGGERS),
    stageKey: z.string().max(64).nullable().optional(),
    dayOffset: z.number().int().min(0).max(730).nullable().optional(),
    everyDays: z.number().int().min(7).max(365).nullable().optional(),
    audience: oneOf(AUDIENCES).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const need = (field: 'stageKey' | 'dayOffset' | 'everyDays') => {
      if (v[field] == null) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required for ${v.trigger}` });
    };
    if (v.trigger === 'STAGE_ENTERED') need('stageKey');
    if (v.trigger === 'DAYS_AFTER_START' || v.trigger === 'DAYS_BEFORE_END' || v.trigger === 'DAYS_AFTER_END') need('dayOffset');
    if (v.trigger === 'RECURRING') need('everyDays');
  });

export async function GET(request: Request) {
  const gate = await requirePermission('content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return withTenantScope(session, async () => {
    const campaigns = await prisma.surveyCampaign.findMany({
      where: withinTenant({}, await tenantWhere(session)),
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { sends: true } }, survey: { select: { id: true, key: true, title: true, status: true } } },
    });
    return NextResponse.json({ campaigns });
  });
}

export async function POST(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;
  const settingsOrg = await settingsOrgOf(session);
  return withTenantScope(session, async () => {
    const survey = await prisma.survey.findFirst({ where: withinTenant({ id: input.surveyId }, await tenantWhere(session)), select: { id: true } });
    if (!survey) return NextResponse.json({ error: 'Survey not found' }, { status: 404 });
    if (input.trigger === 'STAGE_ENTERED') {
      const keys = new Set((await resolvePipelineStages(settingsOrg)).map((s) => s.key));
      if (!keys.has(input.stageKey!)) return NextResponse.json({ error: 'unknown_stage', code: 'unknown_stage' }, { status: 400 });
    }
    const campaign = await prisma.surveyCampaign.create({
      data: {
        orgId: resolveOrgId(session),
        surveyId: survey.id,
        name: input.name,
        trigger: input.trigger as SurveyTrigger,
        stageKey: input.trigger === 'STAGE_ENTERED' ? input.stageKey : null,
        dayOffset: input.trigger === 'DAYS_AFTER_START' || input.trigger === 'DAYS_BEFORE_END' || input.trigger === 'DAYS_AFTER_END' ? input.dayOffset : null,
        everyDays: input.trigger === 'RECURRING' ? input.everyDays : null,
        audience: (input.audience ?? null) as SurveyAudience | null,
        active: input.active ?? true,
      },
    });
    return NextResponse.json({ campaign }, { status: 201 });
  });
}
