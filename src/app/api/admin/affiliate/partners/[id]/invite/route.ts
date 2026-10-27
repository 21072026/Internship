import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { PartnerInviteError, invitePartner } from '@/lib/affiliateInvite';

// POST — invites a partner to open its account (docs/affiliate-module.md, #3117).
// `affiliate.write`. The invitation goes to the partner's contact address and
// withdraws any earlier open one. Another organisation's partner id answers 404,
// like an id that does not exist. `registerUrl` is returned so the admin can
// pass the link on by hand when the mail could not be sent.
const STATUS: Record<PartnerInviteError['code'], number> = {
  partner_not_found: 404,
  already_linked: 409,
  partner_inactive: 409,
  no_contact_email: 400,
  email_taken: 409,
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const { id } = await params;
  try {
    const result = await invitePartner({
      orgId,
      partnerId: id,
      actor: { id: auth.session.user.id, email: auth.session.user.email },
      request,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof PartnerInviteError) {
      if (e.code === 'partner_not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ code: e.code }, { status: STATUS[e.code] });
    }
    throw e;
  }
}
