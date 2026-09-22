import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { redactCompanyForReader } from '@/lib/companyVisibility';
import { NO_MATCH, scopeForRole, logScopeDenial, andScope } from '@/lib/authzScope';

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

export async function GET() {
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

    return await withTenantScope(session, async () => {
      const companies = await prisma.company.findMany({
        // `andScope` copies the builder's object; for ADMIN it is `{}`, which
        // Prisma treats exactly like no `where` at all.
        where: andScope(scope),
        include: {
          needs: true,
          _count: { select: { mentorships: mentorshipCount } },
        },
        orderBy: { name: 'asc' },
      });

      // Which ROWS came back is the scope above (#2431); which COLUMNS of
      // them a non-admin may read is src/lib/companyVisibility.ts — the tax id
      // and the named contact's direct line are ADMIN-only even for a MENTOR
      // who legitimately reads this company.
      return NextResponse.json({
        companies: companies.map((c) => redactCompanyForReader(c, session.user.role)),
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
