import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { AffiliateSettingsError, savePriceList } from '@/lib/affiliateProgramSettings';

// PUT { priceList } — the transaction price list (src/lib/affiliatePriceListRule.ts,
// #3843); `priceList: null` removes it. `affiliate.write`, MARKETING only; the org
// comes from the session. Not the commission plan: the plan version never moves.
// A refused list answers 400 `invalid_price_list` with the fields and their reason.
export async function PUT(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const body = (await request.json().catch(() => null)) as { priceList?: unknown } | null;
  if (!body || !('priceList' in body)) return NextResponse.json({ code: 'invalid_price_list', issues: [{ field: 'priceList', code: 'required' }] }, { status: 400 });
  try {
    const result = await savePriceList(orgId, body.priceList, auth.session.user.id);
    if (!result.ok) return NextResponse.json({ code: 'invalid_price_list', issues: result.issues }, { status: 400 });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AffiliateSettingsError) return NextResponse.json({ code: e.code }, { status: 409 });
    throw e;
  }
}
