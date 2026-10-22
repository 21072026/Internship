import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getLocale } from '@/i18n/server';
import { AffiliateContractError, acceptContract, affiliatePartnerGate } from '@/lib/affiliateContract';
import { contractTextFor, readStoredContract } from '@/lib/affiliateContractRule';

// The partner contract (docs/affiliate-module.md). The one partner route that
// answers before the current contract is accepted (`contract: 'skip'`).
//
// GET  — the current text in the partner's language and where they stand.
// POST — { version } accepts that version; it must be the current one.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const gate = await affiliatePartnerGate(session, { contract: 'skip' });
  if (!gate.ok) return gate.response;
  const settings = await prisma.affiliateProgramSettings.findUnique({
    where: { orgId: gate.partner.orgId },
    select: { contract: true },
  });
  const text = contractTextFor(readStoredContract(settings?.contract), await getLocale());
  return NextResponse.json({ ...gate.contract, locale: text?.locale ?? null, text: text?.text ?? null });
}

const acceptSchema = z.object({ version: z.number().int().positive() });

const STATUS: Record<AffiliateContractError['code'], number> = { stale_version: 409, nothing_to_accept: 409, conflict: 409, invalid_contract: 400 };

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const gate = await affiliatePartnerGate(session, { contract: 'skip' });
  if (!gate.ok) return gate.response;
  // Accepting a contract is the partner's own declaration: never while an admin
  // is signed in as them (the same rule as /api/account).
  if (session.user.impersonatorId) {
    return NextResponse.json({ code: 'impersonating', error: 'Cannot accept the contract while impersonating' }, { status: 400 });
  }
  const parsed = acceptSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });

  try {
    return NextResponse.json(await acceptContract(gate.partner.orgId, gate.partner.id, parsed.data.version, session.user.id));
  } catch (e) {
    if (e instanceof AffiliateContractError) return NextResponse.json({ code: e.code }, { status: STATUS[e.code] });
    throw e;
  }
}
