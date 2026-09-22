import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { redactCompanyForReader } from '@/lib/companyVisibility';
import { NO_MATCH, scopeForRole, logScopeDenial, andScope } from '@/lib/authzScope';

const updateCompanySchema = z.object({
  name: z.string().min(1).max(TEXT_LIMITS.companyName).optional(),
  description: z.string().max(TEXT_LIMITS.companyDescription).optional(),
  contactEmail: z.string().email().max(TEXT_LIMITS.companyContactEmail).optional().or(z.literal('')),
  industry: z.string().max(TEXT_LIMITS.companyIndustry).optional(),
  logoUrl: z.string().url().max(TEXT_LIMITS.companyLogoUrl).or(z.literal('')).optional(),
  size: z.string().max(TEXT_LIMITS.companySize).optional(),
  address: z.string().max(TEXT_LIMITS.companyAddress).optional(),
  quota: z.number().int().min(0).max(10000).nullable().optional(),
  needs: z
    .array(
      z.object({
        id: z.string().optional(),
        position: z.string().min(1).max(TEXT_LIMITS.companyNeedPosition),
        count: z.number().int().min(1),
        period: z.string().min(1).max(TEXT_LIMITS.companyNeedPeriod),
      })
    )
    .optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fail-closed role scoping (#2431) — see GET /api/companies for the why.
    // The 403 / 404 split is the repo's existing convention (authzScope.ts
    // header, e2e/authz-idor.spec.ts), deliberately NOT the inherited backlog's
    // "always 404": a role whose scope is UNDEFINED gets 403 and an audit row,
    // because that is a client asking a question it was never meant to ask; an
    // id that is merely OUTSIDE a defined scope gets the same 404 as an id that
    // does not exist, so the detail route confirms nothing about foreign rows.
    const scope = await scopeForRole(session.user, 'company');
    if (!scope) {
      // The route pattern, not the requested id: every other call site logs a
      // literal route (see `/api/projects`, `/api/mentorship`), so the denials
      // group, and an attacker-supplied id never lands in `ActivityLog.targetId`.
      await logScopeDenial(session.user, 'GET /api/companies/[id]');
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // The nested relations are PII (mentee names + e-mails), so they follow the
    // `relation` scope rather than riding along with the company: a mentor who
    // reaches a company through one relation must not read the other mentors'
    // mentees at that company. ADMIN's `{}` and COMPANY's `companyId = own`
    // leave the payload exactly as it was.
    const relationScope = (await scopeForRole(session.user, 'relation')) ?? { id: NO_MATCH };

    return await withTenantScope(session, async () => {
    const company = await prisma.company.findFirst({
      where: andScope(scope, { id }),
      include: {
        needs: true,
        mentorships: {
          where: relationScope,
          include: {
            mentor: { select: { id: true, fullName: true, email: true } },
            mentee: { select: { id: true, fullName: true, email: true } },
          },
        },
      },
    });

    if (!company) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }

    // Which ROW this reader may fetch is the scope above (#2431); which
    // COLUMNS of it a non-admin may read is src/lib/companyVisibility.ts — the
    // tax id and the named contact's direct line are ADMIN-only even for a
    // MENTOR who legitimately reads this company.
    return NextResponse.json({ company: redactCompanyForReader(company, session.user.role) });
    });
  } catch (error) {
    console.error('Get company error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
    const body = await request.json();
    const parsed = updateCompanySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { needs, contactEmail, ...companyData } = parsed.data;

    const company = await prisma.$transaction(async (tx) => {
      if (needs !== undefined) {
        await tx.companyNeed.deleteMany({ where: { companyId: id } });
      }

      return tx.company.update({
        where: { id },
        data: {
          ...companyData,
          contactEmail: contactEmail || null,
          ...(needs !== undefined && {
            needs: { create: needs.map(({ id: _id, ...n }) => n) },
          }),
        },
        include: { needs: true },
      });
    });

    return NextResponse.json({ company });
    });
  } catch (error) {
    console.error('Update company error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
    await prisma.company.delete({ where: { id } });

    return NextResponse.json({ message: 'Company deleted successfully' });
    });
  } catch (error) {
    console.error('Delete company error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
