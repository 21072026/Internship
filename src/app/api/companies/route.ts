import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { redactCompanyForReader } from '@/lib/companyVisibility';
import { NO_MATCH, scopeForRole, logScopeDenial, andScope } from '@/lib/authzScope';
import {
  companySortKeys,
  compareSortKeys,
  isDerivedSort,
  parseCompanySort,
  type CompanySortRelation,
} from '@/lib/companySort';

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
      const where = andScope(scope, searchFilter);
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
          orderBy: sort === 'created' ? { createdAt: 'desc' } : { name: 'asc' },
          ...(all ? {} : { skip, take: pageSize }),
        });
      } else {
        // "Last stage movement" and "longest waiting in stage" are not columns
        // on Company and cannot be reached by Prisma's `orderBy` (it only
        // crosses a to-many relation through `_count`), so the scoped set is
        // ranked here and the page is sliced from the ranked list — the same
        // shape `/api/candidates` uses for its in-memory skill filter. The
        // extra cost is one relation query, and only for these two orders.
        //
        // It is an UNBOUNDED cost, and that is tracked as #2528: this reads
        // every scoped company and every StatusChange of every relation of
        // those companies before slicing a page out. Fine for an admin's
        // account book today; the two ways to bound it (fetch only the newest
        // real change, or maintain the column) are written up there.
        const rows = await prisma.company.findMany({ where, include, orderBy: { name: 'asc' } });
        // Scoped exactly like the `_count` above, and for the same reason: an
        // ORDER derived from rows the caller may not read is still a fact about
        // them. Unscoped, `sort=movement` would rank a MENTOR's companies by
        // when OTHER mentors last moved a stage there — the inference the count
        // comment three screens up refuses to allow.
        const relations: CompanySortRelation[] = await prisma.mentorshipRelation.findMany({
          where: andScope(relationScope, { companyId: { in: rows.map((c) => c.id) } }),
          select: {
            companyId: true,
            startDate: true,
            // `fromStatus`/`toStatus` come along so `stageClock` can skip the
            // no-op rows (#2264) — the newest row is not necessarily a move.
            statusChanges: { select: { createdAt: true, fromStatus: true, toStatus: true } },
          },
        });
        const keys = companySortKeys(relations, sort);
        // Name is the tie-breaker, including between the accounts that have no
        // key at all: those all land at the end (compareSortKeys), and they
        // stay alphabetical there instead of in whatever order MySQL returned.
        const ranked = rows
          .slice()
          .sort(
            (a, b) =>
              compareSortKeys(keys.get(a.id), keys.get(b.id)) || a.name.localeCompare(b.name)
          );
        companies = all ? ranked : ranked.slice(skip, skip + pageSize);
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
