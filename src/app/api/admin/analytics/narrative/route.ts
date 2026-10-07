import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { isAiConfigured } from '@/lib/ai/provider';
import { getLocale } from '@/i18n/server';
import { analyticsNarrative } from '@/lib/ai/analyticsNarrative';

// The "what changed" paragraph on /admin/analytics (#2046). ADMIN only.
//   GET  — the stored paragraph for exactly the current figures, or none.
//          Never a provider call: loading the dashboard spends nothing.
//   POST — write it (`regenerate` skips the stored one). The figures are
//          recomputed server-side from the same source as the cards, and a
//          paragraph citing any number that is not among them is discarded
//          (`reason: 'unreadable'`), never shown.
// With AI off every card still renders; only this paragraph is absent.

const day = z.string().max(40).optional();
const bodySchema = z.object({ from: day, to: day, regenerate: z.boolean().optional() }).strict();

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const locale = await getLocale();
  const q = new URL(request.url).searchParams;
  return withTenantScope(session, async () => {
    const body = await analyticsNarrative(session, { from: q.get('from'), to: q.get('to') }, locale, { run: false });
    return NextResponse.json({ ...body, configured: isAiConfigured() });
  });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userLimited = enforceRateLimit(request, 'ai:analytics_narrative', { ...AI_RATE_LIMITS.analytics_narrative, subject: session.user.id });
  if (userLimited) return userLimited;
  if (session.user.orgId) {
    const orgLimited = enforceRateLimit(request, 'ai:org', { ...AI_RATE_LIMITS.org_burst, subject: session.user.orgId });
    if (orgLimited) return orgLimited;
  }
  const parsed = bodySchema.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  const locale = await getLocale();
  return withTenantScope(session, async () => {
    const body = await analyticsNarrative(session, { from: parsed.data.from ?? null, to: parsed.data.to ?? null }, locale, { run: true, regenerate: parsed.data.regenerate });
    return NextResponse.json({ ...body, configured: isAiConfigured() });
  });
}
