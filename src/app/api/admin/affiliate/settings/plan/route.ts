import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { AffiliateSettingsError, savePlan } from '@/lib/affiliateProgramSettings';

// PUT — save the commission plan (src/lib/affiliateProgramSettings.ts, the one
// writer). `affiliate.write` (ORG_ADMIN; never while impersonating). A real change
// bumps the plan version and re-evaluates every partner; payments recorded before
// it never get a commission created by the new plan.
const STATUS: Record<AffiliateSettingsError['code'], number> = { invalid_plan: 400, currency_locked: 409, conflict: 409 };

export async function PUT(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  try {
    return NextResponse.json(await savePlan(orgId, await request.json().catch(() => null), auth.session.user.id));
  } catch (e) {
    if (e instanceof AffiliateSettingsError) return NextResponse.json({ code: e.code, issues: e.issues }, { status: STATUS[e.code] });
    throw e;
  }
}
