import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { affiliatePartnerGate } from '@/lib/affiliateContract';
import { PayoutDetailsError, maskedPayoutDetails, setPayoutDetails } from '@/lib/affiliatePayoutDetails';
import { parsePayoutDetails } from '@/lib/payoutDetailsRule';

// The signed-in partner's own payout details (docs/affiliate-module.md). Behind
// the full partner gate (contract accepted). A partner never reads the full IBAN
// back — only its last four characters — and every change is audited and
// announced to the account owner (src/lib/affiliatePayoutDetails.ts).
//
// PUT is refused while an admin impersonates the partner, and while the
// organisation's 2FA policy holds the partner but they have not enrolled: the
// shell's /security-setup redirect does not protect an API, and this is the one
// write that redirects money.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const gate = await affiliatePartnerGate(session);
  if (!gate.ok) return gate.response;
  return NextResponse.json({ details: await maskedPayoutDetails(gate.partner.orgId, gate.partner.id) });
}

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const gate = await affiliatePartnerGate(session);
  if (!gate.ok) return gate.response;
  if (session.user.impersonatorId) {
    return NextResponse.json({ code: 'impersonating', error: 'Cannot change payout details while impersonating' }, { status: 400 });
  }
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { twoFactorEnabled: true } });
  if (!me?.twoFactorEnabled && (await is2faRequiredFor(session.user.role, await settingsOrgOf(session)))) {
    return NextResponse.json({ code: 'two_factor_required' }, { status: 403 });
  }
  const parsed = parsePayoutDetails(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ code: 'invalid_input', issues: parsed.issues }, { status: 400 });

  try {
    const { masked } = await setPayoutDetails({
      orgId: gate.partner.orgId,
      partnerId: gate.partner.id,
      details: parsed.details,
      actor: { id: session.user.id, role: 'AFFILIATE' },
      request,
    });
    return NextResponse.json({ details: { iban: masked, holder: parsed.details.holder } });
  } catch (e) {
    if (e instanceof PayoutDetailsError) return NextResponse.json({ code: e.code }, { status: e.code === 'partner_suspended' ? 409 : 404 });
    throw e;
  }
}
