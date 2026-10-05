import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { logActivity } from '@/lib/activity';
import { ContactEmailTaken, deleteCompanyContact, updateCompanyContact } from '@/lib/companyContacts';
import { adminCompany, DUPLICATE_EMAIL, readContact } from '@/lib/companyContactsAccess';

// One address-book entry (#2442). `contactId` is a row id, or `primary` for the
// account's primary contact (the Company.contact* columns). ADMIN of a
// `companies` org only — src/lib/companyContactsAccess.ts.

type Params = { params: Promise<{ id: string; contactId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withRequestScope(request, async () => {
    const { id, contactId } = await params;
    const access = await adminCompany(await getServerSession(authOptions), id);
    if (access instanceof NextResponse) return access;
    const contact = await readContact(request);
    if (!contact) return NextResponse.json({ error: 'Invalid contact' }, { status: 400 });
    const { session, company } = access;
    return withTenantScope(session, async () => {
      try {
        if (!(await updateCompanyContact(company.id, contactId, contact))) {
          return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
        }
      } catch (e) {
        if (e instanceof ContactEmailTaken) return DUPLICATE_EMAIL();
        throw e;
      }
      await logActivity({
        action: 'company_contact.update',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'company',
        targetId: company.id,
        request,
      });
      return NextResponse.json({ ok: true });
    });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return withRequestScope(request, async () => {
    const { id, contactId } = await params;
    const access = await adminCompany(await getServerSession(authOptions), id);
    if (access instanceof NextResponse) return access;
    const { session, company } = access;
    return withTenantScope(session, async () => {
      if (!(await deleteCompanyContact(company.id, contactId))) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
      }
      await logActivity({
        action: 'company_contact.delete',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'company',
        targetId: company.id,
        request,
      });
      return NextResponse.json({ ok: true });
    });
  });
}
