import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { listOverdueProspects } from '@/lib/prospectRetention';

// GET — the prospect retention review list (MKT-4).
//
// The accounts of the caller's OWN org whose last contact is older than the
// 24 months every postal letter promises, with no customer history and no live
// contact permission (src/lib/prospectRetentionRule.ts). At most 50 rows, each
// carrying the account name and the last-contact date and nothing else; `total`
// is the real count. Read-only: erasure is a separate POST per account.
// Outside the sales-surface vertical the list does not apply and is empty.
export async function GET(request: Request) {
  const gate = await requirePermission('company.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());
    const { applies, total, items } = await listOverdueProspects(orgId);
    return NextResponse.json({
      applies,
      total,
      items: items.map((r) => ({ id: r.companyId, name: r.name, lastContactAt: r.lastContactAt.toISOString() })),
    });
  });
}
