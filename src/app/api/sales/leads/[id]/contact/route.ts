import { NextResponse } from 'next/server';
import { actorFromSession, dispatcherMay, requireRoleOrPermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import { ContactEmailTaken, parseLeadContact, updateLeadContact } from '@/lib/salesLeadContact';

// PATCH { name, email?, phone?, position? } — corrects the contact of one funnel
// record (#3655): the account's primary contact (Company.contact*), and the
// lead row's name and phone with it. Never the lead's login address. Rules and
// rationale: src/lib/salesLeadContact.ts.
//
// WHO: the record's own rep (a MENTOR, or an ADMIN in sales mode, on a vertical
// with the sales surface) — or an admin holding `company.write`, for any record
// of the tenant, as may a sales dispatcher (#3656). Another rep's record, another tenant's, or an unknown id is
// the same 404. Answers 200 { changed, leadRow, contact }; 400 `invalid_input`;
// 409 `duplicate_email` when another contact of the account holds the address;
// 409 `no_account` for a record without an account.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const gate = await requireRoleOrPermission(['MENTOR'], 'company.write', { request });
    if ('error' in gate) return gate.error;
    const { session, admin } = gate;
    const capabilities = await shellCapabilities(session.user.orgId);
    if (!hasSalesSurface(session.user.role, capabilities)) {
      return NextResponse.json({ code: 'vertical_unavailable' }, { status: 403 });
    }
    const fields = parseLeadContact(await request.json().catch(() => null));
    if (!fields) return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
    const { id } = await params;
    // A sales dispatcher works every record of the tenant as its owner (#3656).
    const anyRecord = admin || dispatcherMay(await actorFromSession(session), 'relation.write', session.user.orgId);

    return withTenantScope(session, async () => {
      let result;
      try {
        result = await updateLeadContact({
          relationId: id,
          // A rep only ever reaches their own record; an admin with company.write or a dispatcher any of the tenant.
          ownerId: anyRecord ? null : session.user.id,
          tenant: await tenantWhere(session),
          orgId: session.user.orgId ?? null,
          actorId: session.user.id,
          fields,
        });
      } catch (e) {
        if (e instanceof ContactEmailTaken) return NextResponse.json({ code: 'duplicate_email' }, { status: 409 });
        throw e;
      }
      if (!result.ok) {
        return result.code === 'not_found'
          ? NextResponse.json({ error: 'Not found' }, { status: 404 })
          : NextResponse.json({ code: 'no_account' }, { status: 409 });
      }
      return NextResponse.json({ changed: result.changed, leadRow: result.leadRow, contact: result.contact });
    });
  });
}
