import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';

// Admin view of the enquiries left on /for-companies (#1104). Read + a status
// change; the reply itself happens by email (the notification mail is sent with
// the company's address as Reply-To).
//
// Every `where` below is narrowed to the caller's tenant EXPLICITLY
// (tenantWhere, #2542/#2569). `CompanyInquiry` is registered in TENANT_MODELS
// and both handlers run inside withTenantScope, but that middleware injects
// nothing while MT_ENFORCE_ISOLATION is off — which it is on every deployment —
// so relying on it alone showed a MARKETING admin the internship tenant's
// enquiries and the reverse. That is also why the public submit
// (/api/company-inquiry) stamps an org rather than leaving NULL.
//
// In a MARKETING org this list is also the "unowned leads" list (#2580): a demo
// request that is not converted has not been placed on anybody's funnel yet.
const STATUSES = ['NEW', 'CONTACTED', 'CLOSED'] as const;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const status = new URL(request.url).searchParams.get('status');
    const tenant = await tenantWhere(session);
    const where = withinTenant(
      status && (STATUSES as readonly string[]).includes(status)
        ? { status: status as (typeof STATUSES)[number] }
        : {},
      tenant,
    );

    const items = await prisma.companyInquiry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, companyName: true, contactName: true, email: true, phone: true,
        openRoles: true, message: true, status: true, createdAt: true, handledAt: true,
        // The MARKETING demo form's fields (#2569).
        marketplaces: true, marketingOptIn: true,
        utmSource: true, utmMedium: true, utmCampaign: true, referrer: true,
        handledBy: { select: { fullName: true } },
        // What the enquiry became, if it was converted (#1863) — the row shows a
        // link to the account instead of offering to create a second one.
        convertedAt: true,
        convertedCompany: { select: { id: true, name: true } },
      },
    });
    const newCount = await prisma.companyInquiry.count({ where: withinTenant({ status: 'NEW' as const }, tenant) });
    // Not yet on anybody's funnel and not closed by hand — the "unowned" count.
    const unownedCount = await prisma.companyInquiry.count({
      where: withinTenant({ convertedCompanyId: null, status: { not: 'CLOSED' as const } }, tenant),
    });
    return NextResponse.json({ items, newCount, unownedCount });
  });
}

const patchSchema = z.object({
  id: z.string().min(1),
  status: z.enum(STATUSES),
});

export async function PATCH(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  return await withTenantScope(session, async () => {
    // Another tenant's id is a 404, not an update (#2569).
    const existing = await prisma.companyInquiry.findFirst({
      where: withinTenant({ id: parsed.data.id }, await tenantWhere(session)),
      select: { id: true },
    });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const inquiry = await prisma.companyInquiry.update({
      where: { id: parsed.data.id },
      data: {
        status: parsed.data.status,
        // "Who picked this up, and when" — the point of the list is that an
        // enquiry cannot sit unanswered without anyone noticing.
        handledAt: parsed.data.status === 'NEW' ? null : new Date(),
        handledById: parsed.data.status === 'NEW' ? null : session.user.id,
      },
      select: { id: true, status: true },
    });
    await logActivity({
      action: 'company_inquiry.status',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
    });
    return NextResponse.json({ inquiry });
  });
}
