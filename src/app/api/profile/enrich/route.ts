import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { runAiGated } from '@/lib/aiGate';
import { enrichMentorProfile, type MentorProfileProposal } from '@/lib/ai/authoringAssist';

// POST — proposed bio, expertise and interests for the calling MENTOR's own
// profile, from a career summary they pasted (#2055, part 2). Participant-side
// and free: a mentor improving their own profile is never paywalled. Gated on
// the mentor's own AI_CV_PARSING consent (the same kind of personal text). No
// URL is fetched, no LinkedIn profile scraped. Returns a proposal; the mentor
// accepts each field into the form and nothing is saved until they save.

const schema = z.object({ text: z.string().trim().min(20).max(12_000) }).strict();

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTOR') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const limited = enforceRateLimit(request, 'ai:profile_enrich', { ...AI_RATE_LIMITS.profile_enrich, subject: session.user.id });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const gated = await runAiGated<MentorProfileProposal>({
      orgId: await settingsOrgOf(session),
      scope: 'profile_enrich',
      consent: { userId: session.user.id, type: 'AI_CV_PARSING' },
      userId: session.user.id,
      call: () => enrichMentorProfile(parsed.data.text),
    });
    if (!gated.ok) {
      if (gated.reason === 'no_consent') return NextResponse.json({ error: 'Consent required', code: 'consent_required' }, { status: 403 });
      // Never a paywall for a participant — just "not right now".
      const status = gated.reason === 'not_configured' ? 501 : gated.reason === 'quota_exceeded' ? 429 : 503;
      return NextResponse.json({ error: 'Suggestions are not available right now', code: gated.reason }, { status });
    }
    return NextResponse.json({ proposal: gated.result });
  });
}
