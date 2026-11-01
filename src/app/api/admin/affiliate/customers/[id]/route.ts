import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { parseCustomerLabel } from '@/lib/affiliateCustomerLabelRule';
import { setCustomerLabel } from '@/lib/affiliateCustomerLabel';

// PATCH — the label a partner sees next to a customer's reference
// (docs/affiliate-module.md, #3352). `affiliate.write`. Body `{ partnerLabel }`:
// a string (trimmed, ≤ 80 characters) or null/"" to clear it. Another
// organisation's customer answers 404, like an id that does not exist.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const body = (await request.json().catch(() => null)) as { partnerLabel?: unknown } | null;
  const label = parseCustomerLabel(body?.partnerLabel);
  if (label === undefined) return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  const { id } = await params;
  if (!(await setCustomerLabel(orgId, id, label, auth.session.user.id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true, partnerLabel: label });
}
