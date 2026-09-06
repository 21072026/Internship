import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { getMentorAvailability } from '@/lib/mentorAvailability';
import { applyScanCap, matchesTextFilters, pageSlice, toStringArray } from '@/lib/mentorDirectory';
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

    // `fullName` is neither unique nor indexed, so ordering by it alone leaves
    // ties to the filesort — and MySQL is explicitly free to break them
    // differently for a different LIMIT/OFFSET. With `skip`/`take` paging over
    // that, two mentors sharing a name can land on page 1 AND page 2, or on
    // neither. The `id` tiebreaker makes the order total, which is what makes
    // the pages disjoint and complete (same shape as /api/offers).
    const orderBy: Prisma.UserOrderByWithRelationInput[] = [{ fullName: 'asc' }, { id: 'asc' }];

    const fetchCards = (args: { where: Prisma.UserWhereInput; skip?: number; take?: number }) =>
      prisma.user.findMany({ where: args.where, select, orderBy, skip: args.skip, take: args.take });
    type CardRow = Awaited<ReturnType<typeof fetchCards>>[number];

    // One groupBy covers the ACTIVE-mentee count of every mentor in `ids` (same
    // approach as /api/users?view=mentorAvailability) instead of a query per
    // mentor. Callers pass the smallest set they can get away with: the page,
    // or — when `accepting=1` forces it — the rows that survived the text
    // filters. Never the whole pre-filter scan.
    const activeCounts = async (ids: string[]) => {
      if (!ids.length) return new Map<string, number>();
      const counts = await prisma.mentorshipRelation.groupBy({
        by: ['mentorId'],
        where: { mentorId: { in: ids }, status: 'ACTIVE' },
        _count: { _all: true },
      });
      return new Map(counts.map((c) => [c.mentorId, c._count._all]));
    };

    const toCards = async (rows: CardRow[]) => {
      const counts = await activeCounts(rows.map((r) => r.id));
      return rows.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
        bio: r.bio,
        city: r.city,
        country: r.country,
        skills: toStringArray(r.skills),
        languages: toStringArray(r.languages),
        interests: r.interests,
        mentorCapacity: r.mentorCapacity,
        acceptingMentees: r.acceptingMentees,
        availabilityStatus: getMentorAvailability({
          mentorCapacity: r.mentorCapacity,
          activeMenteeCount: counts.get(r.id) ?? 0,
          acceptingMentees: r.acceptingMentees,
        }).status,
      }));
    };

    // Which filters can the database do, and which are still stuck in JS?
    //   skill / language — matched inside the `skills` / `languages` JSON
    //     arrays, which MySQL cannot search case-insensitively. Blocked on the
    //     Skill/UserSkill join table (#1815); after that this becomes an
    //     ordinary relation `where`.
    //   accepting        — derived from getMentorAvailability(), i.e. the
    //     mentor's own preference compared against a *counted* number of ACTIVE
    //     relations. Not a column, so not a `where` clause either.
    if (!(skill || language || acceptingOnly)) {
      // The whole query is expressible in SQL, so let the database do both jobs:
      // one page of rows, and a count over the SAME where the page came from.
      // This is the branch /api/candidates already uses (#1392).
      const [rows, total] = await Promise.all([
        fetchCards({ where, skip: (page - 1) * pageSize, take: pageSize }),
        prisma.user.count({ where }),
      ]);
      return NextResponse.json({ mentors: await toCards(rows), total, page, pageSize, partial: false });
    }

    // Fetch → filter → slice. The old code did `take: 500` here and then
    // reported the size of the survivors as the total, so a mentor holding the
    // searched skill but sorting 501st did not exist and nothing said the
    // answer was partial (#1820). The cap is now far higher, and — the actual
    // fix — reaching it is reported instead of hidden.
    //
    // The scan reads only the columns the JS filter itself needs. /mentors
    // re-runs this 300 ms after every keystroke in the skill/language boxes, so
    // dragging up to CAP full cards (bio and all) through the Node heap per
    // keystroke would be a real regression; the card payload is re-read below
    // for the ≤ pageSize rows that actually survive.
    const scanned = await prisma.user.findMany({
      where,
      select: {
        id: true,
        skills: true,
        languages: true,
        interests: true,
        mentorCapacity: true,
        acceptingMentees: true,
      },
      orderBy,
      take: JS_FILTER_SCAN_CAP + 1, // limit+1 probe: the extra row is what makes `partial` exact
    });
    const { rows: scanRows, truncated: partial } = applyScanCap(scanned, JS_FILTER_SCAN_CAP);

    let matches = scanRows.filter((r) => matchesTextFilters(r, skill, language));
    if (acceptingOnly) {
      const counts = await activeCounts(matches.map((r) => r.id));
      matches = matches.filter(
        (r) =>
          getMentorAvailability({
            mentorCapacity: r.mentorCapacity,
            activeMenteeCount: counts.get(r.id) ?? 0,
            acceptingMentees: r.acceptingMentees,
          }).status === 'available'
      );
    }

    // `total` describes the set that was actually filtered — never a truncated
    // read dressed up as a complete one. If the scan itself hit the cap, say so
    // explicitly so the UI can warn instead of quietly under-reporting.
    const total = matches.length;
    const pageIds = pageSlice(matches, page, pageSize).map((r) => r.id);
    // Re-read the full card payload for just this page. The visibility `where`
    // is re-applied alongside the ids, so the allowlisted select can never be
    // reached through an id that would not pass the consent gate on its own.
    const cardRows = pageIds.length ? await fetchCards({ where: { AND: [where, { id: { in: pageIds } }] } }) : [];
    const byId = new Map(cardRows.map((r) => [r.id, r]));
    const ordered = pageIds.map((id) => byId.get(id)).filter((r): r is CardRow => Boolean(r));

    return NextResponse.json({
      mentors: await toCards(ordered),
      total,
      page,
      pageSize,
      partial,
      ...(partial ? { cap: JS_FILTER_SCAN_CAP } : {}),
    });
  });
}
