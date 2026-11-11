import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { SurveyConflict, updateSurvey, updateSurveySchema } from '@/lib/surveys';
import { requirePermission } from '@/lib/authz';

// One survey (#1879). Another tenant's survey answers exactly like a missing
// one. PATCH enforces the write-boundary rules in src/lib/surveys.ts: once the
// survey has left DRAFT its question keys and types are frozen (409
// `questions_locked`), and it never goes back to DRAFT (409 `reopen_draft`).

async function load(id: string, session: Parameters<typeof tenantWhere>[0]) {
  return prisma.survey.findFirst({
    where: withinTenant({ id }, await tenantWhere(session)),
    include: { questions: { orderBy: { sortOrder: 'asc' } }, _count: { select: { invitations: true, responses: true } } },
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.read', { request: _request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  return withTenantScope(session, async () => {
    const survey = await load(id, session);
    if (!survey) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ survey });
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  const parsed = updateSurveySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  return withTenantScope(session, async () => {
    const current = await load(id, session);
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    try {
      const survey = await updateSurvey(current, parsed.data);
      return NextResponse.json({ survey });
    } catch (error) {
      if (error instanceof SurveyConflict) return NextResponse.json({ error: error.code, code: error.code }, { status: 409 });
      throw error;
    }
  });
}
