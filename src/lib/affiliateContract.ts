// Saving and accepting the partner contract, and the gate in front of every
// partner API (docs/affiliate-module.md, #3115). The rules are pure in
// src/lib/affiliateContractRule.ts; this file is the only one that writes
// AffiliateProgramSettings.contract/contractVersion and AffiliateContractAcceptance.

import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { contractChanged, contractStateFor, type ContractState, type ContractTexts } from '@/lib/affiliateContractRule';

export type AffiliateContractErrorCode =
  | 'conflict' // another save changed the contract between our read and our write
  | 'stale_version' // the partner accepted a version that is no longer current
  | 'nothing_to_accept'; // no contract has been published

export class AffiliateContractError extends Error {
  readonly code: AffiliateContractErrorCode;
  constructor(code: AffiliateContractErrorCode) {
    super(code);
    this.name = 'AffiliateContractError';
    this.code = code;
  }
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Publishes the contract texts. An unchanged text (compared locale by locale)
 * keeps the version; a changed one bumps it by one, so every partner must accept
 * again. The bump is a guarded update on the version that was read: two saves at
 * once cannot both write the same next version with different texts.
 */
export async function saveContract(orgId: string, texts: ContractTexts, actorId: string): Promise<{ changed: boolean; version: number }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.affiliateProgramSettings.findUnique({
        where: { orgId },
        select: { contract: true, contractVersion: true },
      });
      if (!contractChanged(current?.contract ?? null, texts)) return { changed: false, version: current?.contractVersion ?? 0 };

      const value = texts as Prisma.InputJsonValue;
      const audit = (version: number) =>
        tx.auditLog.create({
          data: { orgId, actorId, action: 'affiliate.contract.publish', detail: JSON.stringify({ version, locales: Object.keys(texts).sort() }) },
        });
      if (!current) {
        await tx.affiliateProgramSettings.create({ data: { orgId, contract: value, contractVersion: 1 } });
        await audit(1);
        return { changed: true, version: 1 };
      }
      const next = current.contractVersion + 1;
      const { count } = await tx.affiliateProgramSettings.updateMany({
        where: { orgId, contractVersion: current.contractVersion },
        data: { contract: value, contractVersion: next },
      });
      if (count !== 1) throw new AffiliateContractError('conflict');
      await audit(next);
      return { changed: true, version: next };
    });
  } catch (e) {
    // Two first saves of one organisation: the loser hits the unique orgId.
    if (isUniqueViolation(e)) throw new AffiliateContractError('conflict');
    throw e;
  }
}

/** Records that a partner accepted `version`. Idempotent for the current version; audited once. */
export async function acceptContract(orgId: string, partnerId: string, version: number, actorId: string): Promise<ContractState> {
  const settings = await prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { contractVersion: true } });
  const current = settings?.contractVersion ?? 0;
  if (current === 0) throw new AffiliateContractError('nothing_to_accept');
  if (version !== current) throw new AffiliateContractError('stale_version');
  try {
    await prisma.$transaction([
      prisma.affiliateContractAcceptance.create({ data: { orgId, partnerId, version } }),
      prisma.auditLog.create({
        data: { orgId, actorId, action: 'affiliate.contract.accept', targetId: partnerId, detail: JSON.stringify({ version }) },
      }),
    ]);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e; // already accepted: the same answer, no second audit row
  }
  return contractState(orgId, partnerId);
}

export async function contractState(orgId: string, partnerId: string): Promise<ContractState> {
  const [settings, accepted] = await Promise.all([
    prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { contractVersion: true } }),
    prisma.affiliateContractAcceptance.findMany({ where: { orgId, partnerId }, select: { version: true } }),
  ]);
  return contractStateFor(settings?.contractVersion ?? 0, accepted.map((a) => a.version));
}

export interface GatedPartner {
  id: string;
  orgId: string;
  code: string;
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
}

export type PartnerGateResult =
  | { ok: true; partner: GatedPartner; contract: ContractState }
  | { ok: false; response: NextResponse };

/**
 * The gate in front of every partner API. The handler reads the session itself
 * (scripts/check-route-auth.mjs) and hands it here. It answers:
 * - 403 for anyone who is not an AFFILIATE, or outside a vertical with the module;
 * - 404 when the account has no partner record in its organisation;
 * - 409 `contract_not_accepted` while the current contract is not accepted —
 *   unless the handler IS the contract route (`contract: 'skip'`).
 * The partner is resolved from the session only, never from the request.
 */
export async function affiliatePartnerGate(session: Session, opts: { contract: 'required' | 'skip' } = { contract: 'required' }): Promise<PartnerGateResult> {
  const orgId = session.user.orgId;
  if (session.user.role !== 'AFFILIATE' || !orgId) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  if (!(await shellCapabilities(orgId)).includes('affiliate')) {
    return { ok: false, response: NextResponse.json({ code: 'capability_unavailable', capability: 'affiliate' }, { status: 403 }) };
  }
  const partner = await prisma.affiliatePartner.findFirst({
    where: { orgId, userId: session.user.id },
    select: { id: true, orgId: true, code: true, displayName: true, status: true },
  });
  if (!partner) return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) };

  const contract = await contractState(orgId, partner.id);
  if (opts.contract === 'required' && contract.mustAccept) {
    return {
      ok: false,
      response: NextResponse.json({ code: 'contract_not_accepted', version: contract.currentVersion }, { status: 409 }),
    };
  }
  return { ok: true, partner, contract };
}
