import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { AffiliateSettingsError, saveReferralUrl } from '@/lib/affiliateProgramSettings';

// PUT { referralUrl } — the base URL partners' referral links are built on
// (src/lib/affiliateReferralRule.ts). `affiliate.write`. An empty value clears it;
// a refused one answers 400 `invalid_referral_url` with its reason.
export async function PUT(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const body = await request.json().catch(() => null);
  try {
    const result = await saveReferralUrl(orgId, body?.referralUrl, auth.session.user.id);
    if (!result.ok) return NextResponse.json({ code: 'invalid_referral_url', issue: result.issue }, { status: 400 });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AffiliateSettingsError) return NextResponse.json({ code: e.code }, { status: 409 });
    throw e;
  }
}
