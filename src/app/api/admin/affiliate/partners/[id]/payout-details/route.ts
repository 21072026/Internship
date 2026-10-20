import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { open, seal } from '@/lib/secretBox';
import {
  decodePayoutDetails,
  encodePayoutDetails,
  isValidIban,
} from '@/lib/affiliatePayoutDetails';

// A partner's bank details, for the admin's manual transfers (docs/affiliate-module.md,
// decision 9). Stored sealed; only an ADMIN of the partner's own organisation reads
// or writes them. Another organisation's partner answers 404, like a missing one.

const PURPOSE = 'affiliate.payout';

const putSchema = z.object({
  accountHolder: z.string().trim().min(1).max(120),
  iban: z.string().min(15).max(40),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN' || !session.user.orgId) return null;
  return session;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  return withTenantScope(session, async () => {
    const partner = await prisma.affiliatePartner.findFirst({
      where: { id, orgId: session.user.orgId as string },
      select: { payoutDetailsCipher: true },
    });
    if (!partner) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (!partner.payoutDetailsCipher) return NextResponse.json({ details: null });

    const opened = open(partner.payoutDetailsCipher, PURPOSE);
    const details = opened === null ? null : decodePayoutDetails(opened);
    if (!details) return NextResponse.json({ error: 'unreadable' }, { status: 409 });
    return NextResponse.json({ details });
  });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  if (!isValidIban(parsed.data.iban)) {
    return NextResponse.json({ error: 'INVALID_IBAN' }, { status: 422 });
  }

  return withTenantScope(session, async () => {
    const result = await prisma.affiliatePartner.updateMany({
      where: { id, orgId: session.user.orgId as string },
      data: {
        payoutDetailsCipher: seal(
          encodePayoutDetails({ accountHolder: parsed.data.accountHolder, iban: parsed.data.iban }),
          PURPOSE,
        ),
      },
    });
    if (result.count === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    // The IBAN is never echoed back: the admin reads it through GET, deliberately.
    return NextResponse.json({ ok: true });
  });
}
