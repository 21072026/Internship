import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { getLocale } from '@/i18n/server';
import { loadSurveyResults } from '@/lib/surveyResults';

// One survey's results (#1910): NPS with its bands and trend, a distribution
// per question, the response rate, floored breakdowns and the unattributed
// free text. ADMIN only, checked here — a mentor never reaches any of it.
// Every suppression rule lives in src/lib/surveyResults.ts.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { id } = await params;
  const locale = await getLocale();
  return withTenantScope(session, async () => {
    // Another tenant's survey answers exactly like a missing one.
    const owned = await prisma.survey.findFirst({ where: withinTenant({ id }, await tenantWhere(session)), select: { id: true } });
    if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ results: await loadSurveyResults(owned.id, locale) });
  });
}
