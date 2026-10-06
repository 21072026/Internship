import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { getLocale } from '@/i18n/server';
import { loadSurveyOverview } from '@/lib/surveyOverview';

// The surveys block of the print report (#1910): one row per survey, floored
// like the results screen. ADMIN only, checked here.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const locale = await getLocale();
  return withTenantScope(session, async () => NextResponse.json({ surveys: await loadSurveyOverview(await tenantWhere(session), locale) }));
}
