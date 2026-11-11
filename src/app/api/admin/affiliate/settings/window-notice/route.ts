import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { AffiliateSettingsError, saveWindowNoticeDays } from '@/lib/affiliateProgramSettings';

// PUT { windowNoticeDays } — how many days before a customer's commission window
// ends its partner is told (#3556, src/lib/affiliateWindowNoticeRule.ts). 0 turns
// the notice off. `affiliate.write`, MARKETING only; the org comes from the
// session. A body without the key, or a value outside 0…180, is 400 `invalid_input`.
export async function PUT(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('windowNoticeDays' in body)) {
    return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  }
  try {
    const result = await saveWindowNoticeDays(orgId, (body as { windowNoticeDays: unknown }).windowNoticeDays, auth.session.user.id);
    if (!result.ok) return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AffiliateSettingsError) return NextResponse.json({ code: e.code }, { status: 409 });
    throw e;
  }
}
