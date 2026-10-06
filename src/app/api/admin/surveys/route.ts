import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { createSurvey, createSurveySchema } from '@/lib/surveys';

// The survey engine's admin surface (#1879): list and create. No screen yet —
// the builder is a later task of #1877; this is the write boundary the rules
// in src/lib/surveys.ts sit behind.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return withTenantScope(session, async () => {
    const surveys = await prisma.survey.findMany({
      where: withinTenant({}, await tenantWhere(session)),
      orderBy: { createdAt: 'desc' },
      select: { id: true, key: true, title: true, audience: true, anonymity: true, status: true, opensAt: true, closesAt: true, minResponses: true, _count: { select: { invitations: true, responses: true } } },
    });
    return NextResponse.json({ surveys });
  });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const parsed = createSurveySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  return withTenantScope(session, async () => {
    const survey = await createSurvey(resolveOrgId(session), parsed.data);
    return NextResponse.json({ survey }, { status: 201 });
  });
}
