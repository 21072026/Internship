import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { getLocale } from '@/i18n/server';
import { INSIGHT_KINDS, type InsightKind } from '@/lib/insights/openTextSources';
import { insightFiltersSchema, insightsResponse, resolveFilters } from '@/lib/insights/insightsResponse';

// Open-text insights (#2046): the themes behind evaluation comments
// (`evaluations`) and the weekly-report digest (`weekly-reports`) — recurring
// blockers across interns, who has not handed in last week, and the week-by-
// week figures.
//   • ADMIN only, tenant-scoped (by hand, docs/tenant-isolation.md), and an
//     internship module (the `mentorship` capability).
//   • GET never calls the provider: it returns the numbers and, if one is
//     stored for exactly the current rows, the summary. POST generates.
//   • Below NAMED_ROWS_FLOOR usable rows the summary is refused and says so.
//   • With AI off or the provider down every number still comes back; only
//     `summary` is null, with `reason` saying why.

function kindOf(raw: string): InsightKind | null {
  return (INSIGHT_KINDS as readonly string[]).includes(raw) ? (raw as InsightKind) : null;
}

export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const kind = kindOf((await params).kind);
  if (!kind) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;

  const q = new URL(request.url).searchParams;
  const parsed = insightFiltersSchema.safeParse({
    ...(q.get('from') ? { from: q.get('from') } : {}),
    ...(q.get('to') ? { to: q.get('to') } : {}),
    ...(q.get('cohortId') ? { cohortId: q.get('cohortId') } : {}),
  });
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  const filters = resolveFilters(kind, parsed.data);
  if (!filters) return NextResponse.json({ error: 'invalid_range', code: 'invalid_range' }, { status: 400 });
  const locale = await getLocale();
  return withTenantScope(session, async () => NextResponse.json(await insightsResponse(session, kind, filters, locale, { run: false })));
}

export async function POST(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const kind = kindOf((await params).kind);
  if (!kind) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const userLimited = enforceRateLimit(request, 'ai:open_text_insights', { ...AI_RATE_LIMITS.open_text_insights, subject: session.user.id });
  if (userLimited) return userLimited;
  if (session.user.orgId) {
    const orgLimited = enforceRateLimit(request, 'ai:org', { ...AI_RATE_LIMITS.org_burst, subject: session.user.orgId });
    if (orgLimited) return orgLimited;
  }
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;

  const parsed = insightFiltersSchema.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  const filters = resolveFilters(kind, parsed.data);
  if (!filters) return NextResponse.json({ error: 'invalid_range', code: 'invalid_range' }, { status: 400 });
  const locale = await getLocale();
  return withTenantScope(session, async () =>
    NextResponse.json(await insightsResponse(session, kind, filters, locale, { run: true, regenerate: parsed.data.regenerate })),
  );
}
