import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { forgetCompanyContact } from '@/lib/accountErasure';
import { normalizeContactEmail } from '@/lib/companyContactErasure';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';

// POST — forget a company contact who never had an account (#2559, DSGVO
// Art. 17). A web enquiry's sender or an imported account's named person
// exists only as an address on `CompanyInquiry` and `Company.contact*`, so the
// account erasure (/api/admin/users/[id]/erase) could never reach them.
//
// The same shape as that route, on purpose: ADMIN only, never while
// impersonating, the admin's OWN password as step-up, a misclick guard (here
// the address typed twice, since there is no name to confirm), and one
// ActivityLog row. The rule itself is #2434's (companyContactErasure.ts) —
// matched on the address, confined to the admin's tenant, the Company row kept.
const bodySchema = z.object({
  // 191: CompanyInquiry.email and Company.contactEmail are plain `String` (VARCHAR(191)).
  email: z.string().trim().email().max(191),
  confirmEmail: z.string().trim().min(1).max(191),
  adminPassword: z.string().min(1),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Cannot erase contacts while impersonating' }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const email = normalizeContactEmail(parsed.data.email);
    if (normalizeContactEmail(parsed.data.confirmEmail) !== email) {
      return NextResponse.json({ error: 'The addresses do not match — nothing was erased', code: 'confirm_mismatch' }, { status: 400 });
    }

    const admin = await prisma.user.findUnique({ where: { id: session.user.id }, select: { password: true } });
    if (!admin || !(await bcrypt.compare(parsed.data.adminPassword, admin.password))) {
      return NextResponse.json({ error: 'Your password is incorrect' }, { status: 400 });
    }

    // Somebody with an ACCOUNT here is erased through that account, which also
    // reaches what they wrote in messages, notes and support threads — scrubbing
    // only their enquiry would leave the rest behind and look finished.
    const account = await prisma.user.findFirst({
      where: withinTenant({ email }, await tenantWhere(session)),
      select: { id: true },
    });
    if (account) {
      return NextResponse.json(
        { error: 'This address belongs to an account — erase the account instead', code: 'has_account', userId: account.id },
        { status: 409 },
      );
    }

    const result = await forgetCompanyContact(email, resolveOrgId(session), randomUUID());
    if (result.inquiries === 0 && result.companies === 0) {
      return NextResponse.json({ error: 'No contact with this address in your organization', code: 'not_found' }, { status: 404 });
    }

    await logActivity({
      action: 'company_contact.forget',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'company_contact',
      targetId: null,
      // Counts only: the address IS the personal data this erased, so writing it
      // here would keep exactly what the request asked us to forget.
      detail: `${result.inquiries} enquiries, ${result.companies} companies`,
      request,
    });

    return NextResponse.json({ ok: true, ...result });
  });
}
