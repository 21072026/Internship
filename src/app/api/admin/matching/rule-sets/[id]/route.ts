import { NextResponse } from 'next/server';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { archiveRuleSet } from '@/lib/matching/ruleSetStore';
import { requirePermission } from '@/lib/authz';

// DELETE archives a rule set (#1783) — never removes it, so a decision made
// under it (#1789) still resolves. An archived default stops being the
// default; the org then scores with the built-in set.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('program.write', { request: _request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const refusal = await requireCapability(session.user.orgId, 'mentorship');
  if (refusal) return refusal;
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());
    if (!(await archiveRuleSet(orgId, id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
