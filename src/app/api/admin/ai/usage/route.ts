import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { currentPeriod, isPeriod, previousPeriod } from '@/lib/meteringRules';
import { getAiQuota } from '@/lib/aiGate';
import { loadMonthRows, loadMonthUsage } from '@/lib/ai/console';
import { toCsv } from '@/lib/reports/render';

// GET — AI usage and spend for the admin's organisation (#2030): a month
// (`?month=YYYY-MM`, default the current one) and the month before it, by
// task — calls, ok / parse_error / provider_error, tokens, list-price spend,
// p50/p95 latency — plus the monthly quota. `?format=csv` returns that
// month's metered calls as rows instead (the meter only: no user, no content).
// ADMIN only, checked here. Aggregated in SQL (src/lib/ai/console.ts).

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const month = params.get('month') ?? currentPeriod();
  if (!isPeriod(month)) return NextResponse.json({ error: 'Invalid month' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const orgId = await settingsOrgOf(session);
    if (params.get('format') === 'csv') {
      const rows = await loadMonthRows(orgId, month);
      const csv = toCsv({
        name: `ai-usage-${month}`,
        columns: ['createdAt', 'task', 'outcome', 'model', 'inputTokens', 'outputTokens', 'costUsd', 'latencyMs', 'flags'],
        rows: rows.map((r) => [
          r.createdAt.toISOString(), r.scope, r.outcome, r.model ?? '', r.inputTokens ?? '', r.outputTokens ?? '',
          r.costMicros === null ? '' : (r.costMicros / 1_000_000).toFixed(6), r.latencyMs ?? '', r.flags ?? '',
        ]),
      });
      return new NextResponse(csv, {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ai-usage-${month}.csv"`, 'Cache-Control': 'no-store' },
      });
    }
    const [current, previous, quota] = await Promise.all([loadMonthUsage(orgId, month), loadMonthUsage(orgId, previousPeriod(month)), getAiQuota(orgId)]);
    return NextResponse.json({ month, current, previous, quota: { quota: quota.quota, used: quota.used, remaining: quota.remaining } }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
