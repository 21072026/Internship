import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { getLocale } from '@/i18n/server';
import { loadSurveyCompletion } from '@/lib/surveyCompletion';
import { requirePermission } from '@/lib/authz';

// A survey's completion console (#1889): invited / answered / rate, the
// reminder state, and — except on an ANONYMOUS survey, where the list is not
// in this payload at all — the people who have not answered yet. ADMIN only,
// checked here; hiding the nav item is not a check. src/lib/surveyCompletion.ts.
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
    return NextResponse.json({ completion: await loadSurveyCompletion(owned.id, locale) });
  });
}
