import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { andScope, logScopeDenial, scopeForRole } from '@/lib/authzScope';
import { redactContactForReader } from '@/lib/companyVisibility';
import { logActivity } from '@/lib/activity';
import { ContactEmailTaken, createCompanyContact, listCompanyContacts } from '@/lib/companyContacts';
import { adminCompany, DUPLICATE_EMAIL, readContact } from '@/lib/companyContactsAccess';

// An account's address book (#2442, docs/company-contacts.md).
//
// GET  — whoever may read the company (`scopeForRole(user, 'company')`, #2431),
//        with the columns `companyVisibility` keeps ADMIN-only stripped.
// POST — ADMIN of a `companies` org adds a contact; the account's first one
//        becomes its primary.

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const scope = await scopeForRole(session.user, 'company');
    if (!scope) {
      await logScopeDenial(session.user, 'GET /api/companies/[id]/contacts');
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { id } = await params;
    return withTenantScope(session, async () => {
      const company = await prisma.company.findFirst({
        where: andScope(scope, withinTenant({ id }, await tenantWhere(session))),
        select: { id: true },
      });
      if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
      const contacts = await listCompanyContacts(company.id);
      return NextResponse.json({ contacts: contacts.map((c) => redactContactForReader(c, session.user.role)) });
    });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const { id } = await params;
    const access = await adminCompany(await getServerSession(authOptions), id);
    if (access instanceof NextResponse) return access;
    const contact = await readContact(request);
    if (!contact) return NextResponse.json({ error: 'Invalid contact' }, { status: 400 });
    const { session, company } = access;
    return withTenantScope(session, async () => {
      try {
        const contactId = await createCompanyContact(company, contact);
        await logActivity({
          action: 'company_contact.create',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'company',
          targetId: company.id,
          request,
        });
        return NextResponse.json({ id: contactId }, { status: 201 });
      } catch (e) {
        if (e instanceof ContactEmailTaken) return DUPLICATE_EMAIL();
        throw e;
      }
    });
  });
}
