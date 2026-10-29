import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { getLocale } from '@/i18n/server';
import { loadSurveyOverview } from '@/lib/surveyOverview';

// The surveys block of the print report (#1910): one row per survey, floored
// like the results screen. ADMIN only, checked here.
export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const locale = await getLocale();
  return withTenantScope(session, async () => NextResponse.json({ surveys: await loadSurveyOverview(await tenantWhere(session), locale) }));
}
