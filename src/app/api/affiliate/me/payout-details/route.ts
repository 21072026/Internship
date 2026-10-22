import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { affiliatePartnerGate } from '@/lib/affiliateContract';
import { PayoutDetailsError, maskedPayoutDetails, setPayoutDetails } from '@/lib/affiliatePayoutDetails';
import { parsePayoutDetails } from '@/lib/payoutDetailsRule';

// The signed-in partner's own payout details (docs/affiliate-module.md). Behind
// the full partner gate (contract accepted). A partner never reads the full IBAN
// back — only its last four characters — and every change is audited and
// announced to the account owner (src/lib/affiliatePayoutDetails.ts).
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
