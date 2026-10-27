import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { AffiliateContractError, saveContract } from '@/lib/affiliateContract';
import { parseContractTexts } from '@/lib/affiliateContractRule';

// PUT — publish the partner contract (src/lib/affiliateContract.ts, the one
// writer). `affiliate.write`. A real text change bumps the version, and every
// partner must accept it again before the portal and its API answer.
export async function PUT(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const body = await request.json().catch(() => null);
  const parsed = parseContractTexts(body?.texts);
  if (!parsed.ok) return NextResponse.json({ code: 'invalid_contract', issues: parsed.issues }, { status: 400 });
  try {
    return NextResponse.json(await saveContract(orgId, parsed.texts, auth.session.user.id));
  } catch (e) {
    if (e instanceof AffiliateContractError) {
      return NextResponse.json({ code: e.code }, { status: e.code === 'invalid_contract' ? 400 : 409 });
    }
    throw e;
  }
}
