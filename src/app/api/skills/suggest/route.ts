import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireCapability } from '@/lib/capabilityGate';
import { defaultOrgId } from '@/lib/defaultOrg';
import { getLocale } from '@/i18n/server';
import { SUGGEST_DEFAULT_LIMIT, suggestSkills } from '@/lib/skillsResolve';

// Skill autocomplete for the shared skills field (#1818): the org's ACTIVE
// canonical vocabulary, labelled in the reader's language.
//
// Whose vocabulary is decided by the server, never by a client-supplied org id:
//   - signed in: the caller's own org (any role — mentors and mentees pick
//     skills for free, so this is never entitlement-gated);
//   - signed out on a mentor's apply link: `?mentorId=` → that mentor's org,
//     only for a link /api/apply itself would accept;
//   - signed out on the public mentor application: `?context=mentor-application`
//     → the default org, which is where /api/mentor-applications files it.
// Anything else signed out gets an empty list. Signed-out calls are rate-limited
// per IP; the answer carries labels only, never who holds them.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') ?? '';
  const limit = Number(url.searchParams.get('limit') ?? SUGGEST_DEFAULT_LIMIT);
  const locale = await getLocale();

  const session = await getServerSession(authOptions);
  if (session) {
    return await withTenantScope(session, async () => {
      const orgId = resolveOrgId(session);
      if (!orgId) return NextResponse.json({ suggestions: [] });
      return NextResponse.json({ suggestions: await suggestSkills(orgId, q, locale, limit) });
    });
  }

  const limited = enforceRateLimit(request, 'skills-suggest', { limit: 120, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  let orgId: string | null = null;
  const mentorId = url.searchParams.get('mentorId');
  if (mentorId) {
    const mentor = await prisma.user.findFirst({
      where: { id: mentorId, role: { in: ['MENTOR', 'ADMIN'] }, isActive: true },
      select: { orgId: true },
    });
    if (mentor && !(await requireCapability(mentor.orgId, 'mentorship'))) orgId = mentor.orgId ?? (await defaultOrgId());
  } else if (url.searchParams.get('context') === 'mentor-application') {
    orgId = await defaultOrgId();
  }
  if (!orgId) return NextResponse.json({ suggestions: [] });
  return NextResponse.json({ suggestions: await suggestSkills(orgId, q, locale, limit) });
}
