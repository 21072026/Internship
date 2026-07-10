import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasFeature } from '@/lib/entitlements';
import { getSetting } from '@/lib/settings';

// GET — premium talent-pool search for companies (Faz 1, #528). Gated by the
// TALENT_POOL_SEARCH entitlement. Privacy-safe: only surfaces mentees who have
// opted into a public profile (publicProfile=true) — the same visibility as the
// public /p/[id] page — so no mentee is exposed without their own opt-in.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY' && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Admins can always view (support); companies need the premium entitlement.
  if (session.user.role === 'COMPANY' && !(await hasFeature(session.user.companyId, 'TALENT_POOL_SEARCH'))) {
    return NextResponse.json({ error: 'feature_locked' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').trim().slice(0, 100);
  const skill = (searchParams.get('skill') || '').trim().slice(0, 60).toLowerCase();

  // Visibility = publicProfile opt-in AND an active TALENT_POOL_VISIBILITY
  // consent (#527, GDPR basis for company-facing exposure). Revoking the
  // consent removes the mentee from company search immediately.
  const where: Record<string, unknown> = {
    role: 'MENTEE',
    isActive: true,
    publicProfile: true,
    consents: { some: { type: 'TALENT_POOL_VISIBILITY', grantedAt: { not: null }, revokedAt: null } },
  };
  if (q) {
    where.OR = [
      { fullName: { contains: q } },
      { university: { contains: q } },
      { department: { contains: q } },
      { targetPosition: { contains: q } },
      { city: { contains: q } },
    ];
  }

  const rows = await prisma.user.findMany({
    where,
    take: 60,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true, fullName: true, university: true, department: true,
      graduationYear: true, city: true, targetPosition: true, skills: true, avatarUrl: true,
    },
  });

  // skills is a JSON array — filter in JS when a skill query is given.
  let candidates = skill
    ? rows.filter((r) => Array.isArray(r.skills) && (r.skills as string[]).some((s) => String(s).toLowerCase().includes(skill)))
    : rows;

  // Early-access window (#531): a candidate who became hireable (HIREABLE_600)
  // within the last N days is visible ONLY to premium companies holding the
  // EARLY_ACCESS entitlement (admins always see everyone). Non-entitled
  // subscribers see them once the window closes. The window length is an admin
  // setting; '0' disables it. Candidates who never became hireable, or whose
  // window has closed, are unaffected.
  const windowDays = parseInt(await getSetting('earlyAccessWindowDays'), 10) || 0;
  const hasEarlyAccess = session.user.role === 'ADMIN' || (await hasFeature(session.user.companyId, 'EARLY_ACCESS'));
  if (windowDays > 0 && !hasEarlyAccess && candidates.length > 0) {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const recent = await prisma.statusChange.findMany({
      where: {
        toStatus: 'HIREABLE_600',
        createdAt: { gte: cutoff },
        relation: { menteeId: { in: candidates.map((c) => c.id) } },
      },
      select: { relation: { select: { menteeId: true } } },
    });
    const embargoed = new Set(recent.map((s) => s.relation.menteeId));
    candidates = candidates.filter((c) => !embargoed.has(c.id));
  }

  return NextResponse.json({ candidates });
}
