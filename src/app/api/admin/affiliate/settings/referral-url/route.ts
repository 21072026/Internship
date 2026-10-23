import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { AffiliateSettingsError, saveReferralUrl } from '@/lib/affiliateProgramSettings';

// PUT { referralUrl } — the base URL partners' referral links are built on
// (src/lib/affiliateReferralRule.ts). `affiliate.write`. An explicit null or ""
// clears it; a body without the key is 400 `invalid_input`; a refused URL answers
// 400 `invalid_referral_url` with its reason.
export async function PUT(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const body: unknown = await request.json().catch(() => null);
  // The key must be there: a malformed or empty body is not "clear the address".
  // Clearing is an explicit `null` or "".
  if (!body || typeof body !== 'object' || !('referralUrl' in body)) {
    return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  }
  try {
    const result = await saveReferralUrl(orgId, (body as { referralUrl: unknown }).referralUrl, auth.session.user.id);
    if (!result.ok) return NextResponse.json({ code: 'invalid_referral_url', issue: result.issue }, { status: 400 });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AffiliateSettingsError) return NextResponse.json({ code: e.code }, { status: 409 });
    throw e;
  }
}
