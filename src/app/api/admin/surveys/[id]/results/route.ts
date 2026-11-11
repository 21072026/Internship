import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { getLocale } from '@/i18n/server';
import { loadSurveyResults } from '@/lib/surveyResults';
import { requirePermission } from '@/lib/authz';

// One survey's results (#1910): NPS with its bands and trend, a distribution
// per question, the response rate, floored breakdowns and the unattributed
// free text. ADMIN only, checked here — a mentor never reaches any of it.
// Every suppression rule lives in src/lib/surveyResults.ts.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.read', { request: _request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  const locale = await getLocale();
  return withTenantScope(session, async () => {
    // Another tenant's survey answers exactly like a missing one.
    const owned = await prisma.survey.findFirst({ where: withinTenant({ id }, await tenantWhere(session)), select: { id: true } });
    if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ results: await loadSurveyResults(owned.id, locale) });
  });
}
