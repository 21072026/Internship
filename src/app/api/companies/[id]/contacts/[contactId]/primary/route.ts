import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { logActivity } from '@/lib/activity';
import { ContactEmailTaken, makeContactPrimary } from '@/lib/companyContacts';
import { adminCompany, DUPLICATE_EMAIL } from '@/lib/companyContactsAccess';

// POST — make a contact row the account's primary contact (#2442). One
// transaction under the company row's lock: the row's person moves into the
// Company.contact* columns and the previous primary becomes a new row, so two
// concurrent requests can never leave two primaries or lose a person. A second
// request for the same row finds it consumed and gets 404.

export async function POST(request: Request, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  return withRequestScope(request, async () => {
    const { id, contactId } = await params;
    const access = await adminCompany(await getServerSession(authOptions), id);
    if (access instanceof NextResponse) return access;
    const { session, company } = access;
    return withTenantScope(session, async () => {
      try {
        if (!(await makeContactPrimary(company.id, contactId))) {
          return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
        }
      } catch (e) {
        if (e instanceof ContactEmailTaken) return DUPLICATE_EMAIL();
        throw e;
      }
      await logActivity({
        action: 'company_contact.primary',
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
