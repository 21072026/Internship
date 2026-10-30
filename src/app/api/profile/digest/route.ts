import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { normalizeThemes } from '@/lib/matching/semantic';
import { refreshProfileDigest } from '@/lib/profileDigest';
import { requireCapability } from '@/lib/capabilityGate';
import { shellCapabilities } from '@/lib/shellCapabilities';

// The caller's OWN profile digest (#2038): the summary and themes the
// semantic match rule compares them by. A profile summary a person cannot see
// is not explainable, so GET shows exactly what is stored and POST asks for a
// fresh one. Both read the session's user only — no id is taken from the
// request, so nobody can read or regenerate another person's digest here.
//
// POST answers with what happened: `updated`, `unchanged` (nothing to
// regenerate from a text that did not change unless `force` — the button
// always forces), `removed` / `empty` (nothing written to summarise), or a
// refusal code (`consent_required`, or the AI being unavailable — the stored
// digest, if any, stays as it was).

async function ownDigest(userId: string) {
  const row = await prisma.profileDigest.findUnique({
    where: { userId },
    select: { digest: true, themes: true, updatedAt: true },
  });
  return row ? { digest: row.digest, themes: normalizeThemes(row.themes), updatedAt: row.updatedAt } : null;
}

export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Matching is an internship module: in a product without it there is no
    // digest to show, and the profile page draws no card (`available: false`).
    if (!(await shellCapabilities(session.user.orgId)).includes('mentorship')) return NextResponse.json({ available: false, digest: null });
    return withTenantScope(session, async () => NextResponse.json({ available: true, digest: await ownDigest(session.user.id) }));
  });
}

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const denied = await requireCapability(session.user.orgId, 'mentorship');
    if (denied) return denied;
    const limited = enforceRateLimit(request, 'ai:profile_digest', { ...AI_RATE_LIMITS.profile_digest, subject: session.user.id });
    if (limited) return limited;
    return withTenantScope(session, async () => {
      const r = await refreshProfileDigest(session.user.id, { force: true });
      if (r.status === 'denied') {
        if (r.reason === 'no_consent') return NextResponse.json({ error: 'Consent required', code: 'consent_required' }, { status: 403 });
        const status = r.reason === 'not_configured' ? 501 : r.reason === 'quota_exceeded' ? 429 : r.reason === 'missing' ? 404 : 503;
        return NextResponse.json({ error: 'Not available right now', code: r.reason, digest: await ownDigest(session.user.id) }, { status });
      }
      return NextResponse.json({ status: r.status, digest: await ownDigest(session.user.id) });
    });
  });
}
