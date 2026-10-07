import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { AI_PACK_FEATURE, runAiGated } from '@/lib/aiGate';
import { enrichCompany, type CompanyProposal } from '@/lib/ai/authoringAssist';

// POST — a proposed description and sector for a company record, from text the
// admin PASTED (#2055, part 2). ADMIN only, checked here. No URL is fetched and
// no website or profile is scraped. Returns a proposal; the admin accepts each
// field into the form, and nothing is saved until they save it.

const schema = z.object({ text: z.string().trim().min(20).max(12_000) }).strict();

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const limited = enforceRateLimit(request, 'ai:company_enrich', { ...AI_RATE_LIMITS.company_enrich, subject: session.user.id });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const gated = await runAiGated<CompanyProposal>({
      orgId: await settingsOrgOf(session),
      scope: 'company_enrich',
      userId: session.user.id,
      call: () => enrichCompany(parsed.data.text),
    });
    if (!gated.ok) {
      // An operator task without the AI pack (#1738): the shared locked shape.
      if (gated.reason === 'not_entitled') return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: AI_PACK_FEATURE }, { status: 403 });
      const status = gated.reason === 'not_configured' ? 501 : gated.reason === 'quota_exceeded' ? 429 : 503;
      return NextResponse.json({ error: 'Suggestions are not available right now', code: gated.reason }, { status });
    }
    return NextResponse.json({ proposal: gated.result });
  });
}
