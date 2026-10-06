import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { SurveyConflict, updateSurvey, updateSurveySchema } from '@/lib/surveys';

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
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const survey = await load(id, session);
    if (!survey) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ survey });
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
