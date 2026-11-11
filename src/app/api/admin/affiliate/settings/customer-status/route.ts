import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { AffiliateSettingsError, saveCustomerStatusSettings } from '@/lib/affiliateProgramSettings';

// PUT { freeMonths, passiveAfterDays } — the customer-status thresholds
// (src/lib/affiliateCustomerStatusRule.ts, #3542). `affiliate.write`, MARKETING
// only; the org comes from the session. Not the commission plan: the plan
// version never moves. A refused value answers 400 `invalid_settings` with the
// fields and their reason.
export async function PUT(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const body: unknown = await request.json().catch(() => null);
  try {
    const result = await saveCustomerStatusSettings(orgId, body, auth.session.user.id);
    if (!result.ok) return NextResponse.json({ code: 'invalid_settings', issues: result.issues }, { status: 400 });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AffiliateSettingsError) return NextResponse.json({ code: e.code }, { status: 409 });
    throw e;
  }
}
