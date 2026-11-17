import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { parseCustomerLabel } from '@/lib/affiliateCustomerLabelRule';
import { setCustomerLabel, setCustomerReverseCharge } from '@/lib/affiliateCustomerLabel';

// PATCH — a customer's admin-kept fields (docs/affiliate-module.md). `affiliate.write`.
// Body `{ partnerLabel?, reverseCharge? }`, at least one:
// - `partnerLabel` (#3352): the label a partner sees next to the customer's
//   reference; a string (trimmed, ≤ 80 characters) or null/"" to clear it;
// - `reverseCharge` (#3843): a boolean, invoiced without VAT.
// Another organisation's customer answers 404, like an id that does not exist.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const raw: unknown = await request.json().catch(() => null);
  const body = raw && typeof raw === 'object' ? (raw as { partnerLabel?: unknown; reverseCharge?: unknown }) : null;
  const hasLabel = !!body && 'partnerLabel' in body;
  const hasReverseCharge = !!body && 'reverseCharge' in body;
  if (!hasLabel && !hasReverseCharge) return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  const label = hasLabel ? parseCustomerLabel(body!.partnerLabel) : null;
  if (label === undefined) return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  if (hasReverseCharge && typeof body!.reverseCharge !== 'boolean') return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  const { id } = await params;
  const actorId = auth.session.user.id;
  if (hasLabel && !(await setCustomerLabel(orgId, id, label, actorId))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (hasReverseCharge && !(await setCustomerReverseCharge(orgId, id, body!.reverseCharge as boolean, actorId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...(hasLabel ? { partnerLabel: label } : {}), ...(hasReverseCharge ? { reverseCharge: body!.reverseCharge } : {}) });
}
