import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { AI_PACK_FEATURE, runAiGated } from '@/lib/aiGate';
import { draftContent } from '@/lib/ai/authoringAssist';
import { TRANSLATION_PURPOSES, type LocaleMap } from '@/lib/machineTranslation';

// POST — a draft in all three languages from a short brief (#2055, part 2):
// an announcement, a goal template or a message template. ADMIN only, checked
// here. Returns the draft and nothing else — it lands in the editor, marked
// machine-written in every locale, and nothing is saved, published, queued or
// sent until the admin does it themselves.

const schema = z.object({ purpose: z.enum(TRANSLATION_PURPOSES), brief: z.string().trim().min(3).max(2000) }).strict();

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const limited = enforceRateLimit(request, 'ai:content_draft', { ...AI_RATE_LIMITS.content_draft, subject: session.user.id });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const gated = await runAiGated<LocaleMap>({
      orgId: await settingsOrgOf(session),
      scope: 'content_draft',
      userId: session.user.id,
      call: () => draftContent(parsed.data),
    });
    if (!gated.ok) {
      // An operator task without the AI pack (#1738): the shared locked shape.
      if (gated.reason === 'not_entitled') return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: AI_PACK_FEATURE }, { status: 403 });
      const status = gated.reason === 'not_configured' ? 501 : gated.reason === 'quota_exceeded' ? 429 : 503;
      return NextResponse.json({ error: 'Drafting is not available right now', code: gated.reason }, { status });
    }
    return NextResponse.json({ draft: gated.result });
  });
}
