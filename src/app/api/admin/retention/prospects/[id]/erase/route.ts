import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { eraseProspectContact } from '@/lib/prospectRetention';
import { requireCapability } from '@/lib/capabilityGate';

// POST — erase the contact data of ONE overdue prospect (MKT-4).
//
// The only way a prospect's data leaves on account of the 24-month promise: an
// admin's click, never a job. Org-scoped: an account of another org — or any
// account when this org has no prospects — is a 404, never a 403 that would
// confirm the id. An account the review list would not show (a customer, a
// live permission, a recent contact, already erased) is a 409 and nothing is
// written. The Company row stays; one AuditLog row records the click.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePermission('company.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Cannot erase contact data while impersonating' }, { status: 400 });
  }
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());
    const blocked = await requireCapability(orgId, 'companies');
    if (blocked) return blocked;
    const result = await eraseProspectContact(orgId, id, session.user.id);
    if (result.kind === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (result.kind === 'not_overdue') {
      return NextResponse.json({ error: 'This account is not due for erasure', code: 'not_overdue', reason: result.reason }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      companies: result.companies,
      inquiries: result.inquiries,
      contacts: result.contacts,
      letters: result.letters,
    });
  });
}
