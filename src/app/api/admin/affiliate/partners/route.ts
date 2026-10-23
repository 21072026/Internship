import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { decide } from '@/lib/authzRule';
import { requireCapability } from '@/lib/capabilityGate';
import { PartnerCodeTakenError, createPartner, listPartners, parsePartnerInput } from '@/lib/affiliatePartners';

// The programme's partners (docs/affiliate-module.md, #3116). GET: `affiliate.read`;
// POST (new partner): `affiliate.write`. The org is the session's, never the request's.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;
  const canWrite = decide({ actor: auth.actor, permission: 'affiliate.write' }).allow;
  return NextResponse.json({ partners: await listPartners(orgId), canWrite });
}

export async function POST(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = parsePartnerInput(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ code: 'invalid_input', issues: parsed.issues }, { status: 400 });
  try {
    return NextResponse.json(await createPartner(orgId, parsed.value, auth.session.user.id), { status: 201 });
  } catch (e) {
    if (e instanceof PartnerCodeTakenError) return NextResponse.json({ code: 'code_taken' }, { status: 409 });
    throw e;
  }
}
