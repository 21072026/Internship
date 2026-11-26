import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { EmailInviteError, invitePartnerByEmail, parseEmailInviteInput } from '@/lib/affiliateEmailInvite';

// POST { email, displayName? } — creates a partner with a placeholder random
// code and invites it (docs/affiliate-module.md, #3963). `affiliate.write`; the
// org is the session's. 409 `email_is_partner` when the address is a partner's
// contact already, 409 `email_taken` when it has an account in this product.
// `registerUrl` comes back only when the mail could not be sent.
export async function POST(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = parseEmailInviteInput(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ code: 'invalid_input', issues: parsed.issues }, { status: 400 });
  try {
    const result = await invitePartnerByEmail({
      orgId,
      value: parsed.value,
      actor: { id: auth.session.user.id, email: auth.session.user.email },
      request,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof EmailInviteError) return NextResponse.json({ code: e.code }, { status: 409 });
    throw e;
  }
}
