import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { getMentorAvailability } from '@/lib/mentorAvailability';
import type { Prisma } from '@prisma/client';

// Upper bound on the rows the in-memory filter branch is allowed to scan
// (#1820). It exists only because the skill/language filters still have to run
// in JavaScript; it is NOT a page size and it is NOT silent — whenever the scan
// actually reaches it the response says `partial: true` and names the cap, and
// the directory renders a "this list may be incomplete" notice. Once the
// taxonomy join table (#1815) lands, the filter moves into `where` and this
// whole branch — cap included — goes away.
const JS_FILTER_SCAN_CAP = 2000;

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
    const where: Prisma.UserWhereInput = {
      role: 'MENTOR',
      isActive: true,
      publicProfile: true,
      orgId: resolveOrgId(session),
      consents: { some: { type: 'MENTOR_DIRECTORY_VISIBILITY', grantedAt: { not: null }, revokedAt: null } },
    };

    const select = {
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
    } as const;
    const orderBy = { fullName: 'asc' } as const;

    // Which filters can the database do, and which are still stuck in JS?
    //   skill / language — matched inside the `skills` / `languages` JSON
    //     arrays, which MySQL cannot search case-insensitively. Blocked on the
    //     Skill/UserSkill join table (#1815); after that this becomes an
    //     ordinary relation `where`.
    //   accepting        — derived from getMentorAvailability(), i.e. the
    //     mentor's own preference compared against a *counted* number of ACTIVE
    //     relations. Not a column, so not a `where` clause either.
    const needsInMemoryFilter = Boolean(skill || language || acceptingOnly);

    let rows;
    let scanTruncated = false;
    if (!needsInMemoryFilter) {
      // The whole query is expressible in SQL, so let the database do both jobs:
      // one page of rows, and a count over the SAME where the page came from.
      // This is the branch /api/candidates already uses (#1392).
      rows = await prisma.user.findMany({
        where,
        select,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
    } else {
      // Fetch → filter → slice. The old code did `take: 500` here and then
      // reported the size of the survivors as the total, so a mentor holding
      // the searched skill but sorting 501st did not exist and nothing said
      // the answer was partial (#1820). The cap is now far higher, and — the
      // actual fix — reaching it is reported instead of hidden.
      rows = await prisma.user.findMany({ where, select, orderBy, take: JS_FILTER_SCAN_CAP });
      scanTruncated = rows.length >= JS_FILTER_SCAN_CAP;
    }

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

    if (!needsInMemoryFilter) {
      // `rows` is already exactly one page; the total comes from the database.
      const total = await prisma.user.count({ where });
      return NextResponse.json({ mentors, total, page, pageSize, partial: false });
    }

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

    // `total` describes the set that was actually filtered — never a truncated
    // read dressed up as a complete one. If the scan itself hit the cap, say so
    // explicitly so the UI can warn instead of quietly under-reporting.
    const total = mentors.length;
    const pageRows = mentors.slice((page - 1) * pageSize, page * pageSize);

    return NextResponse.json({
      mentors: pageRows,
      total,
      page,
      pageSize,
      partial: scanTruncated,
      ...(scanTruncated ? { cap: JS_FILTER_SCAN_CAP } : {}),
    });
  });
}
