import { NextResponse } from 'next/server';
import { requireRoleOrPermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import { parseLeadContact, updateLeadContact } from '@/lib/salesLeadContact';

// PATCH { name, email?, phone?, position? } — corrects the contact of one funnel
// record (#3655): the account's primary contact (Company.contact*), and the
// lead row's name and phone with it. Never the lead's login address. Rules and
// rationale: src/lib/salesLeadContact.ts.
//
// WHO: the record's own rep (a MENTOR, or an ADMIN in sales mode, on a vertical
// with the sales surface) — or an admin holding `company.write`, for any record
// of the tenant. Another rep's record, another tenant's, or an unknown id is
// the same 404. Answers 200 { changed, contact }; 400 `invalid_input`;
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

    return withTenantScope(session, async () => {
      const result = await updateLeadContact({
        relationId: id,
        // A rep only ever reaches their own record; an admin with company.write any of the tenant.
        ownerId: admin ? null : session.user.id,
        tenant: await tenantWhere(session),
        orgId: session.user.orgId ?? null,
        actorId: session.user.id,
        fields,
      });
      if (!result.ok) {
        return result.code === 'not_found'
          ? NextResponse.json({ error: 'Not found' }, { status: 404 })
          : NextResponse.json({ code: 'no_account' }, { status: 409 });
      }
      return NextResponse.json({ changed: result.changed, contact: result.contact });
    });
  });
}
