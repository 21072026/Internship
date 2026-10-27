// The partner portal's page-side gate (docs/affiliate-module.md, #3117).
//
// The API has affiliatePartnerGate() (src/lib/affiliateContract.ts); the pages
// under /affiliate ask the same questions here, from the session only: which
// partner is this account, and has it accepted the current contract? The layout
// already admits AFFILIATE only, inside a vertical with the module.
//
// Every portal page except the contract page calls `requirePortalPartner()`,
// which sends a partner who has not accepted the current contract to
// /affiliate/contract. A page is a convenience, never the check: the API refuses
// the same partner with 409 `contract_not_accepted`.

import 'server-only';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { contractState, type GatedPartner } from '@/lib/affiliateContract';
import type { ContractState } from '@/lib/affiliateContractRule';

export const CONTRACT_PATH = '/affiliate/contract';

export interface PortalPartner {
  partner: GatedPartner;
  contract: ContractState;
  impersonating: boolean;
}

/** The signed-in partner and its contract state; null for an account without a partner record. */
export async function portalPartner(): Promise<PortalPartner | null> {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'AFFILIATE' || !session.user.orgId) return null;
  const partner = await prisma.affiliatePartner.findFirst({
    where: { orgId: session.user.orgId, userId: session.user.id },
    select: { id: true, orgId: true, code: true, displayName: true, status: true },
  });
  if (!partner) return null;
  return { partner, contract: await contractState(partner.orgId, partner.id), impersonating: Boolean(session.user.impersonatorId) };
}

/** As `portalPartner()`, and on to the contract page while the current version is not accepted. */
export async function requirePortalPartner(): Promise<PortalPartner | null> {
  const portal = await portalPartner();
  if (portal?.contract.mustAccept) redirect(CONTRACT_PATH);
  return portal;
}
