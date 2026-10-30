import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere } from '@/lib/tenantFilter';
import { closureSetup, defaultClosurePeriod, loadClosureReport, setupClosureSurvey } from '@/lib/closureReportData';

// How pairings ended (#1795): the pairings that ended in the period grouped by
// lifecycle outcome and end reason, with the close-loop survey's aggregate
// answers (above the response floor only). ADMIN only, tenant-scoped. Only a
// COMPLETED ending counts as a success — src/lib/closureReport.ts.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: the last twelve months).
export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const params = new URL(request.url).searchParams;
  const period = defaultClosurePeriod();
  const from = params.get('from');
  const to = params.get('to');
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  if (from) period.from = new Date(`${from}T00:00:00Z`);
  if (to) period.to = new Date(`${to}T23:59:59.999Z`);
  if (period.to < period.from) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  return withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const [report, setup] = await Promise.all([loadClosureReport(tenant, period), closureSetup(tenant)]);
    return NextResponse.json({ ...report, setup });
  });
}

// POST — switch the close-loop survey on: the `relation_close` survey and its
// day-0 DAYS_AFTER_END campaign for both sides. Idempotent; never back-fills.
export async function POST(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const { created } = await setupClosureSurvey(tenant, resolveOrgId(session));
    return NextResponse.json({ setup: await closureSetup(tenant) }, { status: created ? 201 : 200 });
  });
}
