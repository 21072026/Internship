import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { isAiConfigured } from '@/lib/ai/provider';
import { AI_PACK_FEATURE } from '@/lib/aiGate';
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
// An operator task behind the AI pack (#1738): GET carries `locked` so the
// card can say so without a call; a POST from an org without the pack is the
// shared 403 `feature_locked` (the gate's 'not_entitled'), never a 200 with a
// reason.

const day = z.string().max(40).optional();
const bodySchema = z.object({ from: day, to: day, regenerate: z.boolean().optional() }).strict();

export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const locale = await getLocale();
  const q = new URL(request.url).searchParams;
  return withTenantScope(session, async () => {
    const body = await analyticsNarrative(session, { from: q.get('from'), to: q.get('to') }, locale, { run: false });
    return NextResponse.json({ ...body, configured: isAiConfigured() });
  });
}

export async function POST(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
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
    if (body.reason === 'not_entitled') {
      return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: AI_PACK_FEATURE }, { status: 403 });
    }
    return NextResponse.json({ ...body, configured: isAiConfigured() });
  });
}
