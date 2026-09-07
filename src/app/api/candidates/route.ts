import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { isTagMode, parseTagIds } from '@/lib/tags';
import { markOrphanApplicants, orphanApplicantWhere } from '@/lib/orphanApplicant';

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
    const { searchParams } = new URL(request.url);
    const skills = searchParams.get('skills');
    const graduationYear = searchParams.get('graduationYear');
    const search = searchParams.get('search');
    const pipelineStatus = searchParams.get('status');
    const city = searchParams.get('city');
    const company = searchParams.get('company');
    const project = searchParams.get('project');
    const cohortId = searchParams.get('cohort');
    const sourceId = searchParams.get('source');
    // Deactivated ("archived") candidates are hidden by default and only shown
    // when the archive view is requested (?archived=1).
    const archived = searchParams.get('archived') === '1';
    // Orphan applicants (#1780): accounts the public apply link created and a
    // mentor declined, which show no other sign of life. `?orphan=1` narrows
    // the list to exactly them; without it they are still MARKED, because the
    // point is to be able to tell one from a real candidate at a glance.
    // The rule itself is never restated here — src/lib/orphanApplicant.ts owns
    // it, and this route asks that module both times.
    const orphanOnly = searchParams.get('orphan') === '1';
    // Pagination. `all=1` returns everything (used by CSV/Excel export so the
    // download isn't limited to the current page).
    const all = searchParams.get('all') === '1';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '24', 10) || 24));

    const where: Record<string, unknown> = {
      role: 'MENTEE',
      // Active candidates by default; the archive view flips this to inactive.
      isActive: !archived,
    };
    if (sourceId) where.sourceId = sourceId;
    // Tag filter (#887). OR (default) = "any of these labels", AND = "all of
    // them" — expressed as one `some` per tag, since a single `some` with an
    // `in` list can be satisfied by one row.
    const tagIds = parseTagIds(searchParams.get('tags'));
    if (tagIds.length > 0) {
      const rawMode = searchParams.get('tagMode');
      const mode = isTagMode(rawMode) ? rawMode : 'or';
      if (mode === 'and') {
        where.AND = tagIds.map((tagId) => ({ tags: { some: { tagId } } }));
      } else {
        where.tags = { some: { tagId: { in: tagIds } } };
      }
    }

    const relSome: Record<string, unknown> = {};
    if (pipelineStatus) relSome.pipelineStatus = pipelineStatus;
    if (company) relSome.company = { name: company };
    if (project) relSome.project = { name: { contains: project } };
    if (cohortId) relSome.cohortId = cohortId;
    if (Object.keys(relSome).length) where.menteeRelations = { some: relSome };
    if (city) where.city = { contains: city };

    // skills filtering is applied in-memory after fetching (MySQL JSON arrays don't support hasSome)
    const skillList = skills
      ? skills.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [];

    if (graduationYear) {
      const year = parseInt(graduationYear, 10);
      if (!isNaN(year)) {
        where.graduationYear = year;
      }
    }

    if (search) {
      where.OR = [
        { fullName: { contains: search } },
        { email: { contains: search } },
        { university: { contains: search } },
        { department: { contains: search } },
      ];
    }

    const select = {
      id: true,
      fullName: true,
      email: true,
      university: true,
      department: true,
      graduationYear: true,
      skills: true,
      cvUrl: true,
      phone: true,
      whatsapp: true,
      city: true,
      createdAt: true,
      isActive: true,
      // The candidate list is where you pick who to write to, so it says which
      // language each of them reads (#1164).
      preferredLanguage: true,
      source: { select: { id: true, name: true } },
      // Tag chips on the row, so a filtered list shows WHY each person matched.
      tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
      menteeRelations: {
        where: { status: 'ACTIVE' as const },
        include: {
          mentor: { select: { id: true, fullName: true } },
          company: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } },
        },
      },
    };
    // Generic so the spread keeps the row's other columns in the type — the
    // `orphan` flag below is attached to these objects and needs `id`.
    const normalize = <T extends { skills: unknown }>(c: T) => ({ ...c, skills: (c.skills ?? []) as string[] });
    const matchesSkills = (c: { skills: string[] }) => {
      if (skillList.length === 0) return true;
      const owned = c.skills.map((k) => k.toLowerCase());
      // Every typed term must be a substring of at least one skill (so "docke"
      // matches "Docker"), case-insensitive.
      return skillList.every((term) => owned.some((k) => k.includes(term)));
    };

    // Composed with AND rather than spread into `where`: the orphan rule already
    // constrains `menteeRelations` and `NOT`, and both of those keys are set
    // above by the stage filter and by nothing respectively — merging by spread
    // would silently drop one of the two rules instead of intersecting them.
    const query = orphanOnly ? { AND: [where, orphanApplicantWhere()] } : where;

    let candidates;
    let total: number;
    if (skillList.length === 0) {
      // No JSON-skill filter → paginate at the database level.
      total = await prisma.user.count({ where: query });
      const raw = await prisma.user.findMany({
        where: query,
        select,
        orderBy: { createdAt: 'desc' },
        ...(all ? {} : { skip: (page - 1) * pageSize, take: pageSize }),
      });
      candidates = raw.map(normalize);
    } else {
      // Skill filter is applied in-memory (MySQL JSON arrays don't support
      // hasSome), so fetch, filter, then slice the page from the filtered set.
      const raw = await prisma.user.findMany({ where: query, select, orderBy: { createdAt: 'desc' } });
      const filtered = raw.map(normalize).filter(matchesSkills);
      total = filtered.length;
      candidates = all ? filtered : filtered.slice((page - 1) * pageSize, page * pageSize);
    }

    // One extra query for the page in hand rather than a per-row check or a
    // second copy of the rule on the client. Skipped for `all=1` (the CSV/Excel
    // export), which is unbounded and does not render a badge — an `IN` list of
    // every candidate in the org is not worth a column nothing reads.
    const orphanIds = all || orphanOnly ? null : await markOrphanApplicants(candidates.map((c) => c.id));
    const withOrphan = candidates.map((c) => ({
      ...c,
      // Under `?orphan=1` every row matched the rule by construction.
      orphan: orphanIds ? orphanIds.has(c.id) : orphanOnly,
    }));

    return NextResponse.json({ candidates: withOrphan, total, page, pageSize });
    });
  } catch (error) {
    console.error('Get candidates error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
