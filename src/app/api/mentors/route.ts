import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { getMentorAvailability } from '@/lib/mentorAvailability';

// GET — mentee-facing mentor directory (#938, story #900). Privacy-safe by
// construction: a mentor is listed ONLY with publicProfile=true AND an active
// MENTOR_DIRECTORY_VISIBILITY consent (granted, not revoked) — the same
// double-opt-in pattern as the company talent pool (#527). Revoking the
// consent removes the card immediately. The select below is a strict
// allowlist: email/phone/whatsapp are never read, so they can never leak.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Fail-closed role gate (#831): only the roles that are explicitly part of
  // the mentee↔mentor matching flow may browse the directory. COMPANY and
  // SOURCE (and anything added later) get 403 — they have their own,
  // separately-consented surfaces (e.g. the talent pool).
  if (!['MENTEE', 'MENTOR', 'ADMIN'].includes(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
    const { searchParams } = new URL(request.url);
    const skill = (searchParams.get('skill') || '').trim().slice(0, 60).toLowerCase();
    const language = (searchParams.get('language') || '').trim().slice(0, 60).toLowerCase();
    const acceptingOnly = searchParams.get('accepting') === '1';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '12', 10) || 12));

    // Visibility = publicProfile opt-in AND an active MENTOR_DIRECTORY_VISIBILITY
    // consent (#937, GDPR basis for mentee-facing exposure). Revoking the
    // consent removes the mentor from the directory immediately.
    const rows = await prisma.user.findMany({
      where: {
        role: 'MENTOR',
        isActive: true,
        publicProfile: true,
        orgId: resolveOrgId(session),
        consents: { some: { type: 'MENTOR_DIRECTORY_VISIBILITY', grantedAt: { not: null }, revokedAt: null } },
      },
      // Mentor counts are small; fetch the consented set and filter/paginate in
      // JS — the skill/language filters match inside JSON arrays, which MySQL
      // `contains` can't do case-insensitively.
      take: 500,
      orderBy: { fullName: 'asc' },
      select: {
        id: true,
        fullName: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        city: true,
        country: true,
        skills: true,
        languages: true,
        interests: true,
        mentorCapacity: true,
        acceptingMentees: true,
      },
    });

    // One groupBy covers every mentor's ACTIVE-mentee count (same approach as
    // /api/users?view=mentorAvailability) instead of a query per mentor.
    const counts = rows.length
      ? await prisma.mentorshipRelation.groupBy({
          by: ['mentorId'],
          where: { mentorId: { in: rows.map((r) => r.id) }, status: 'ACTIVE' },
          _count: { _all: true },
        })
      : [];
    const activeCountByMentorId = new Map(counts.map((c) => [c.mentorId, c._count._all]));

    const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

    let mentors = rows.map((r) => {
      const availability = getMentorAvailability({
        mentorCapacity: r.mentorCapacity,
        activeMenteeCount: activeCountByMentorId.get(r.id) ?? 0,
        acceptingMentees: r.acceptingMentees,
      });
      return {
        id: r.id,
        fullName: r.fullName,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
        bio: r.bio,
        city: r.city,
        country: r.country,
        skills: asArray(r.skills),
        languages: asArray(r.languages),
        interests: r.interests,
        mentorCapacity: r.mentorCapacity,
        acceptingMentees: r.acceptingMentees,
        availabilityStatus: availability.status,
      };
    });

    if (skill) {
      mentors = mentors.filter(
        (m) =>
          m.skills.some((s) => s.toLowerCase().includes(skill)) ||
          (m.interests ?? '').toLowerCase().includes(skill)
      );
    }
    if (language) {
      mentors = mentors.filter((m) => m.languages.some((l) => l.toLowerCase().includes(language)));
    }
    if (acceptingOnly) {
      mentors = mentors.filter((m) => m.availabilityStatus === 'available');
    }

    const total = mentors.length;
    const pageRows = mentors.slice((page - 1) * pageSize, page * pageSize);

    return NextResponse.json({ mentors: pageRows, total, page, pageSize });
  });
}
