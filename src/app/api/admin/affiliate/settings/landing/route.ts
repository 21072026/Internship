import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { AffiliateSettingsError, saveLanding } from '@/lib/affiliateProgramSettings';

// PUT { landing } — the public programme page's content (src/lib/affiliateLandingRule.ts,
// #3359): copy per locale, contact phone and e-mail, the product's sign-up URL.
// `affiliate.write`, MARKETING only. The whole landing is replaced; a body without
// the key is 400 `invalid_input`, a refused value 400 `invalid_landing` with every
// issue by path.
export async function PUT(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('landing' in body)) {
    return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  }
  try {
    const result = await saveLanding(orgId, (body as { landing: unknown }).landing, auth.session.user.id);
    if (!result.ok) return NextResponse.json({ code: 'invalid_landing', issues: result.issues }, { status: 400 });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AffiliateSettingsError) return NextResponse.json({ code: e.code }, { status: 409 });
    throw e;
  }
}
