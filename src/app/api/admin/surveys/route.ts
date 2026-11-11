import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { z } from 'zod';
import { createSurvey, createSurveySchema } from '@/lib/surveys';
import { allowedAudiences, surveyInputFromTemplate } from '@/lib/surveyTemplateInput';
import { listSurveyTemplates, renderSurveyTemplate } from '@/lib/surveyTemplates';
import { getLocale } from '@/i18n/server';
import { requirePermission } from '@/lib/authz';

// The survey engine's admin surface (#1879): list and create. A survey is
// created either from a built-in instrument (#1877 — `{ templateKey, audience,
// anonymity }`, the wording resolved on the server in all three languages) or
// from a full question list. Both land on the same write boundary, the rules
// in src/lib/surveys.ts.

const fromTemplateSchema = z
  .object({
    templateKey: z.string().min(1).max(80),
    audience: z.enum(['MENTEE', 'MENTOR', 'BOTH']).optional(),
    anonymity: z.enum(['IDENTIFIED', 'CONFIDENTIAL', 'ANONYMOUS']).optional(),
  })
  .strict();

export async function GET(request: Request) {
  const gate = await requirePermission('content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const locale = await getLocale();
  // The picker's choices, resolved here so the browser never ships the three
  // dictionaries the template selectors read.
  const instruments = listSurveyTemplates().map((template) => {
    const r = renderSurveyTemplate(template, locale);
    return { key: template.key, title: r.title, description: r.description, questions: r.questions.length, audiences: allowedAudiences(template), anonymityDefault: template.anonymityDefault };
  });
  return withTenantScope(session, async () => {
    const surveys = await prisma.survey.findMany({
      where: withinTenant({}, await tenantWhere(session)),
      orderBy: { createdAt: 'desc' },
      select: { id: true, key: true, title: true, audience: true, anonymity: true, status: true, opensAt: true, closesAt: true, minResponses: true, _count: { select: { invitations: true, responses: true } } },
    });
    return NextResponse.json({ surveys, instruments });
  });
}

export async function POST(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const body = await request.json().catch(() => null);
  let input: unknown = body;
  if (body && typeof body === 'object' && !('questions' in body)) {
    const picked = fromTemplateSchema.safeParse(body);
    if (!picked.success) return NextResponse.json({ error: 'Invalid input', issues: picked.error.issues }, { status: 400 });
    input = surveyInputFromTemplate(picked.data.templateKey, picked.data);
    // An unknown instrument, or an audience it cannot address as one survey.
    if (!input) return NextResponse.json({ error: 'unsupported_template', code: 'unsupported_template' }, { status: 400 });
  }
  const parsed = createSurveySchema.safeParse(input);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  return withTenantScope(session, async () => {
    const survey = await createSurvey(resolveOrgId(session), parsed.data);
    return NextResponse.json({ survey }, { status: 201 });
  });
}
