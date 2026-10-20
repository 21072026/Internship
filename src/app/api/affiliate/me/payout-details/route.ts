import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { seal } from '@/lib/secretBox';
import { encodePayoutDetails, isValidIban } from '@/lib/affiliatePayoutDetails';

// The partner sets their own bank details (docs/affiliate-module.md, decision 9).
// Stored sealed; the admin reads them for the transfer, the partner only sees
// the last four characters back through GET /api/affiliate/me.

const putSchema = z.object({
  accountHolder: z.string().trim().min(1).max(120),
  iban: z.string().min(15).max(40),
});

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'AFFILIATE' || !session.user.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const orgId = session.user.orgId;
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  if (!isValidIban(parsed.data.iban)) {
    return NextResponse.json({ error: 'INVALID_IBAN' }, { status: 422 });
  }

  return withTenantScope(session, async () => {
    const result = await prisma.affiliatePartner.updateMany({
      where: { userId: session.user.id, orgId },
      data: {
        payoutDetailsCipher: seal(
          encodePayoutDetails({ accountHolder: parsed.data.accountHolder, iban: parsed.data.iban }),
          'affiliate.payout',
        ),
      },
    });
    if (result.count === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
