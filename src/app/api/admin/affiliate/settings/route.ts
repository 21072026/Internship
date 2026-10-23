import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { decide } from '@/lib/authzRule';
import { requireCapability } from '@/lib/capabilityGate';
import { programSettings } from '@/lib/affiliateProgramSettings';
import { readStoredContract } from '@/lib/affiliateContractRule';

// GET — the programme's settings (docs/affiliate-module.md): the commission plan,
// the contract texts and their versions. `affiliate.read` (every admin tier),
// MARKETING only; the org comes from the session, never the request.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const s = await programSettings(orgId);
  // Whether this admin may save (an OBSERVER or an impersonated session may not):
  // the same rule the PUT routes apply, so the form never offers a refused write.
  const canWrite = decide({ actor: auth.actor, permission: 'affiliate.write' }).allow;
  return NextResponse.json({ ...s, contract: readStoredContract(s.contract), canWrite });
}
