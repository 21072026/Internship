import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { logActivity } from '@/lib/activity';
import { ContactEmailTaken, moveCompanyContact } from '@/lib/companyContacts';
import { adminCompany, DUPLICATE_EMAIL, findTenantCompany } from '@/lib/companyContactsAccess';

// POST { companyId } — people change jobs: move a contact (a row, or `primary`)
// to another account of the same tenant (#2442). The history is the
// ActivityLog entry this writes — from which account to which, under the
// contact's id at the target — and a row joining an account that already has a
// primary keeps its own id and createdAt.

const schema = z.object({ companyId: z.string().min(1).max(191) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  return withRequestScope(request, async () => {
    const { id, contactId } = await params;
    const access = await adminCompany(await getServerSession(authOptions), id);
    if (access instanceof NextResponse) return access;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const { session, company } = access;
    if (parsed.data.companyId === company.id) {
      return NextResponse.json({ error: 'The contact is already at this account.' }, { status: 400 });
    }
    return withTenantScope(session, async () => {
      // The target is looked up in the SAME tenant: a contact never crosses one.
      const target = await findTenantCompany(session, parsed.data.companyId);
      if (!target) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
      let movedId: string | null;
      try {
        movedId = await moveCompanyContact(company.id, contactId, target.id);
      } catch (e) {
        if (e instanceof ContactEmailTaken) return DUPLICATE_EMAIL();
        throw e;
      }
      if (!movedId) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
      await logActivity({
        action: 'company_contact.moved',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'company_contact',
        targetId: movedId,
        detail: `from company ${company.id} to company ${target.id}`,
        request,
      });
      return NextResponse.json({ id: movedId, companyId: target.id });
    });
  });
}
