import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { affiliatePartnerGate } from '@/lib/affiliateContract';

// GET — the signed-in partner's own record (docs/affiliate-module.md). Behind the
// partner gate: AFFILIATE only, the session's own partner, contract accepted.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const gate = await affiliatePartnerGate(session);
  if (!gate.ok) return gate.response;
  const { partner, contract } = gate;
  return NextResponse.json({
    code: partner.code,
    displayName: partner.displayName,
    status: partner.status,
    contractVersion: contract.currentVersion,
  });
}
