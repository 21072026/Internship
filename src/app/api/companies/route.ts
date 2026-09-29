import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere } from '@/lib/tenantFilter';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { redactCompanyForReader } from '@/lib/companyVisibility';
import { NO_MATCH, scopeForRole, logScopeDenial, andScope } from '@/lib/authzScope';
import {
  companySortKeys,
  derivedPageWindow,
  isDerivedSort,
  isFollowUpSort,
  parseCompanySort,
  rankByDerivedKey,
  type CompanySortRelation,
} from '@/lib/companySort';
import { REAL_STAGE_MOVE } from '@/lib/stageChange';
import type { Prisma } from '@prisma/client';

// The `name` order, made total. `Company.name` is not unique (the marketing
// import dedupes on name + country), and MySQL may return tied rows in a
// different order for a different LIMIT/OFFSET — so without the id two
// same-named accounts could repeat on one page and vanish from the next. The
// derived orders page their never-moved tail with this same order (#2528), so
// the two stay one definition.
const COMPANY_NAME_ORDER: Prisma.CompanyOrderByWithRelationInput[] = [
  { name: 'asc' },
  { id: 'asc' },
];

const companySchema = z.object({
  name: z.string().min(1, 'Company name is required').max(TEXT_LIMITS.companyName),
  description: z.string().max(TEXT_LIMITS.companyDescription).optional(),
  contactEmail: z
    .string()
    .email('Invalid contact email')
    .max(TEXT_LIMITS.companyContactEmail)
    .optional()
    .or(z.literal('')),
  industry: z.string().max(TEXT_LIMITS.companyIndustry).optional(),
  logoUrl: z.string().url().max(TEXT_LIMITS.companyLogoUrl).or(z.literal('')).optional(),
  size: z.string().max(TEXT_LIMITS.companySize).optional(),
  address: z.string().max(TEXT_LIMITS.companyAddress).optional(),
  quota: z.number().int().min(0).max(10000).nullable().optional(),
  needs: z
    .array(
      z.object({
        position: z.string().min(1).max(TEXT_LIMITS.companyNeedPosition),
        count: z.number().int().min(1),
        period: z.string().min(1).max(TEXT_LIMITS.companyNeedPeriod),
      })
    )
    .optional(),
});

/** Same ceiling as `/api/candidates`, for the same reason: one page is a screen. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 24;

/**
 * A page number past this is a crafted URL, not navigation — at the maximum
 * page size it is still a hundred million rows deep.
 *
 * The ceiling is not cosmetic: `parseInt('9'.repeat(20))` is finite and > 0 but
 * not a SAFE integer, and `skip` is an `Int` as far as Prisma's runtime
 * validator is concerned, so an unbounded `page` turns a hand-typed query
 * string into a 500 — on the very parameter whose sibling (`sort`) has "an
 * invalid value must not 500" as an explicit acceptance criterion.
 */
const MAX_PAGE = 1_000_000;

const positiveInt = (raw: string | null, fallback: number, max: number): number => {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fail-closed role scoping (#2431). This handler used to stop at `if
    // (!session)`, so every signed-in role — MENTEE and SOURCE included — read
    // every company in the tenant, `contactEmail` and all. The scope is decided
    // once, in `authzScope.ts` (ADMIN everything, COMPANY its own row, MENTOR
    // the companies of its relations); a role with no builder is refused here.
    // Convention, not invention: scope UNDEFINED for the role → 403 (+ an
    // `authz.scope_denied` activity row); a row that exists but lies outside a
    // defined scope → simply absent from the list, and 404 on the detail route.
    const scope = await scopeForRole(session.user, 'company');
    if (!scope) {
      await logScopeDenial(session.user, 'GET /api/companies');
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // The relation count is data about rows, not a harmless total: unfiltered,
    // it tells a MENTOR how many mentorships a company has altogether — other
    // mentors' included — which is exactly what the detail route's nested
    // `mentorships` are scoped against. So the count follows the same
    // `relation` scope. ADMIN's scope is `{}`; the plain `true` is kept there
    // so the admin query stays byte-identical to the one this handler always
    // ran. Only ADMIN/MENTOR/COMPANY reach this line (the others were refused
    // above) and all three have a `relation` builder, so the fallback is a
    // fail-closed guard, not a path.
    const relationScope = (await scopeForRole(session.user, 'relation')) ?? { id: NO_MATCH };
    const mentorshipCount = Object.keys(relationScope).length > 0 ? { where: relationScope } : true;

    const { searchParams } = new URL(request.url);
    // Server-side ordering (#2436) and server-side search + pagination (#2437),
    // the shape `/api/candidates` already uses. `all=1` is the same escape
    // hatch it has: the screens that render a company <select> (assign a
    // mentorship, pick a company for an offer or a project) need every row, not
    // a page of them.
    const sort = parseCompanySort(searchParams.get('sort'));
    const search = (searchParams.get('search') ?? '').trim();
    const all = searchParams.get('all') === '1';
    const page = positiveInt(searchParams.get('page'), 1, MAX_PAGE);
    const pageSize = positiveInt(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    // The same two columns the client-side `filter()` used to match on, so the
    // move to the server is not also a change of what "search" means.
    const searchFilter = search
      ? { OR: [{ name: { contains: search } }, { industry: { contains: search } }] }
      : undefined;

    return await withTenantScope(session, async () => {
      // `andScope` copies the builder's object; for ADMIN with no search it is
      // `{}`, which Prisma treats exactly like no `where` at all.
      //
      // Tenant (#2542): the role scope above says WHICH of the tenant's
      // companies a role may read; it has never said which tenant. With
      // MT_ENFORCE_ISOLATION off — every deployment today — the middleware
      // injects nothing, and a MARKETING admin read the INTERNSHIP tenant's
      // whole company book. So the tenant is one more conjunct, by hand
      // (src/lib/tenantFilter.ts, the same `resolveOrgId(session)` the
      // middleware reads). Every query below
      // (count, the derived-sort head and tail, the `company: { is: where }`
      // relation filter) is built from this one `where`.
      const where = andScope<Prisma.CompanyWhereInput>(
        scope,
        (await tenantWhere(session)) as Prisma.CompanyWhereInput,
        searchFilter,
      );
      const include = {
        needs: true,
        _count: { select: { mentorships: mentorshipCount } },
      };

      const total = await prisma.company.count({ where });
      const skip = (page - 1) * pageSize;

      let companies;
      if (!isDerivedSort(sort)) {
        companies = await prisma.company.findMany({
          where,
          include,
          orderBy: sort === 'created' ? { createdAt: 'desc' } : COMPANY_NAME_ORDER,
          ...(all ? {} : { skip, take: pageSize }),
        });
      } else {
        // "Last stage movement" and "longest waiting in stage" are not columns
        // on Company and cannot be reached by Prisma's `orderBy` (it only
        // crosses a to-many relation through `_count`), so they are ranked
        // here. Bounded since #2528 — this used to read every scoped company
        // (needs, `_count` and all) plus EVERY StatusChange of every relation
        // of those companies, on any `?sort=movement`, just to slice a page.
        // Now the database does the heavy half:
        //
        //   1. the scoped relations that have EVER really moved — three narrow
        //      columns each, no history;
        //   2. their newest real move, as a `MAX(createdAt) … GROUP BY` — one
        //      row per relation. Not a nested `statusChanges: { take: 1 }`:
        //      across many parents Prisma 5 drops that LIMIT and paginates in
        //      the engine, so every real row would still be loaded;
        //   3. the names of the accounts that got a key, to rank them;
        //   4. full rows for the page only — the keyed head, and then the
        //      keyless tail, which is last by definition and in name order, so
        //      the database pages it (`derivedPageWindow`).
        //
        // Scoped exactly like the `_count` above, and for the same reason: an
        // ORDER derived from rows the caller may not read is still a fact about
        // them. Unscoped, `sort=movement` would rank a MENTOR's companies by
        // when OTHER mentors last moved a stage there — the inference the count
        // comment three screens up refuses to allow.
        let relations: CompanySortRelation[];
        if (isFollowUpSort(sort)) {
          // `followup` (#2563): the owners' next-action dates on the account's
          // ACTIVE records. Same relation scope as the other derived orders,
          // for the same reason — a MENTOR's list must not be ordered by
          // follow-ups other mentors set. One narrow row per dated record.
          const dated = await prisma.mentorshipRelation.findMany({
            where: andScope(relationScope, {
              company: { is: where },
              status: 'ACTIVE',
              nextActionAt: { not: null },
            }),
            select: { companyId: true, startDate: true, nextActionAt: true },
          });
          relations = dated.map((r) => ({ ...r, statusChanges: [] }));
        } else {
          const moved = await prisma.mentorshipRelation.findMany({
            where: andScope(relationScope, {
              company: { is: where },
              // The query-side twin of stageClock's `isRealMove` (#2264): a
              // relation whose only rows are no-ops has never moved.
              statusChanges: { some: REAL_STAGE_MOVE },
            }),
            select: { id: true, companyId: true, startDate: true },
          });
          // StatusChange carries no `orgId` of its own, so it is reached through
          // the relation ids the tenant-scoped query above returned — never
          // through a nested relation filter, which the middleware does not see.
          const lastMoves = moved.length
            ? await prisma.statusChange.groupBy({
                by: ['relationId'],
                where: { ...REAL_STAGE_MOVE, relationId: { in: moved.map((r) => r.id) } },
                _max: { createdAt: true },
              })
            : [];
          const lastMoveOf = new Map(lastMoves.map((m) => [m.relationId, m._max.createdAt]));
          // Each relation hands the clock its single newest real move, which
          // `StageClockSource` accepts as is (the no-ops were filtered by the
          // query). So "has this record ever moved" and both keys are still
          // decided by `companySortKeys` / `lastStageMoveAt`, nowhere else.
          relations = moved.map((r) => {
            const at = lastMoveOf.get(r.id);
            return {
              companyId: r.companyId,
              startDate: r.startDate,
              statusChanges: at ? [{ createdAt: at }] : [],
            };
          });
        }
        const keys = companySortKeys(relations, sort);

        // `where` again, so the head is the scoped + searched set by the same
        // rule as `total`, whatever the relation filter above reached.
        const keyed = keys.size
          ? await prisma.company.findMany({
              where: andScope(where, { id: { in: [...keys.keys()] } }),
              select: { id: true, name: true },
            })
          : [];
        const ranked = rankByDerivedKey(keyed, keys).map((c) => c.id);

        const slot = all ? null : derivedPageWindow(ranked.length, skip, pageSize);
        const headIds = slot ? ranked.slice(slot.headStart, slot.headEnd) : ranked;
        const tailWhere = andScope(where, ranked.length > 0 && { id: { notIn: ranked } });
        const [head, tail] = await Promise.all([
          headIds.length
            ? prisma.company.findMany({ where: andScope(where, { id: { in: headIds } }), include })
            : [],
          !slot || slot.tailTake > 0
            ? prisma.company.findMany({
                where: tailWhere,
                include,
                orderBy: COMPANY_NAME_ORDER,
                ...(slot ? { skip: slot.tailSkip, take: slot.tailTake } : {}),
              })
            : [],
        ]);
        const headById = new Map(head.map((c) => [c.id, c]));
        companies = [
          ...headIds.flatMap((id) => {
            const row = headById.get(id);
            return row ? [row] : [];
          }),
          ...tail,
        ];
      }

      // Which ROWS came back is the scope above (#2431); which COLUMNS of
      // them a non-admin may read is src/lib/companyVisibility.ts — the tax id
      // and the named contact's direct line are ADMIN-only even for a MENTOR
      // who legitimately reads this company.
      return NextResponse.json({
        companies: companies.map((c) => redactCompanyForReader(c, session.user.role)),
        total,
        page,
        pageSize,
        sort,
      });
    });
  } catch (error) {
    console.error('Get companies error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
    const body = await request.json();
    const parsed = companySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { needs, contactEmail, ...companyData } = parsed.data;

    const company = await prisma.company.create({
      data: {
        ...companyData,
        // Stamped by hand (#2542): with the flag off the middleware fills
        // nothing in, and a NULL-org company would be invisible to the very
        // admin who just created it now that the list is org-scoped.
        orgId: resolveOrgId(session),
        contactEmail: contactEmail || null,
        needs: needs
          ? {
              create: needs,
            }
          : undefined,
      },
      include: { needs: true },
    });

    return NextResponse.json({ company }, { status: 201 });
    });
  } catch (error) {
    console.error('Create company error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
