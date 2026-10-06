import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { getLocale } from '@/i18n/server';
import { loadSurveyCompletion } from '@/lib/surveyCompletion';

// A survey's completion console (#1889): invited / answered / rate, the
// reminder state, and — except on an ANONYMOUS survey, where the list is not
// in this payload at all — the people who have not answered yet. ADMIN only,
// checked here; hiding the nav item is not a check. src/lib/surveyCompletion.ts.
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
    return NextResponse.json({ completion: await loadSurveyCompletion(owned.id, locale) });
  });
}
