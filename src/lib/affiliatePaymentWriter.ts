// The ONE writer for affiliate payments and commission amounts (docs/affiliate-module.md, #3114).
//
// Manual entry by an ADMIN today and an API import later both call
// recordAffiliatePayment(); a plan or termination change calls
// resyncPartnerCommissions(). Nothing else creates a payment or creates, changes
// the amount of, or removes a commission. Status changes — approve, reject,
// un-approve (transitionCommissions) and a partner's state (changePartnerState) —
// live here too and take the same partner lock (lockPartner below), so they
// cannot interleave with a reconciliation; a payout takes it as well.
//
// How a write runs:
//   1. Shape checks (pure, src/lib/affiliateCommissionSync.ts) before any lock;
//      references are trimmed (normalizeRef).
//   2. The customer → partner link is read OUTSIDE the transaction, only to choose
//      which partner to lock.
//   3. In one transaction: the partner row is locked FIRST (SELECT … FOR UPDATE).
//      A locking read creates no InnoDB read view, so the first consistent read
//      comes after the lock and sees what the previous holder committed. The
//      customer is read again under the lock, so a customer created by a
//      concurrent payment is found, not re-created.
//   4. The whole payment history goes through the pure engine
//      (src/lib/affiliateCommissionRule.ts) and the pure reconciliation decides the
//      changes. Only PENDING rows of the current plan version move; every guarded
//      write must hit exactly the rows it planned, or the transaction is undone.
//
// Every query names orgId itself, so the writer is right with or without a bound
// tenant context (an import script, a cron). Every write leaves one AuditLog row
// in the same transaction (`affiliate.payment.record`, `affiliate.commissions.resync`).

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { evaluatePartner, MAX_AMOUNT_MINOR, parseCommissionPlan, type CommissionPlan, type PaymentFact } from '@/lib/affiliateCommissionRule';
import {
  checkPaymentInput,
  MAX_REF_LENGTH,
  normalizeRef,
  planCommissionChanges,
  type CommissionDrift,
  type PaymentInputIssue,
  type StoredCommission,
} from '@/lib/affiliateCommissionSync';

export type AffiliateWriteErrorCode =
  | 'invalid_input'
  | 'no_plan' // the organisation has not configured a valid commission plan
  | 'currency_mismatch' // the payment is not in the plan's currency
  | 'partner_not_found' // no such partner in this organisation
  | 'partner_suspended'
  | 'unknown_customer' // a new customer needs a partner
  | 'customer_of_another_partner'
  | 'duplicate_payment' // the external payment reference is already recorded in this organisation
  | 'payout_mismatch' // a payout's commissions are not all APPROVED, of this partner, in one currency
  | 'invalid_transition' // a terminated partner is final: no state change leaves TERMINATED
  | 'busy' // the partner is locked by long-running work or a deadlock was resolved; retry
  | 'conflict'; // a guarded commission write found a row in another state than it read — an invariant broke

export class AffiliateWriteError extends Error {
  readonly code: AffiliateWriteErrorCode;
  readonly issues: PaymentInputIssue[];
  constructor(code: AffiliateWriteErrorCode, issues: PaymentInputIssue[] = []) {
    super(code);
    this.name = 'AffiliateWriteError';
    this.code = code;
    this.issues = issues;
  }
}

export interface RecordPaymentInput {
  orgId: string;
  /** Required when the customer is new; checked against the stored link otherwise. */
  partnerId?: string | null;
  customerExternalRef: string;
  amountMinor: number;
  currency: string;
  receivedAt: Date;
  externalPaymentRef: string;
  source: 'MANUAL' | 'API';
  enteredById?: string | null;
  /** Injected for tests; defaults to the wall clock. */
  now?: Date;
}

export interface SyncResult {
  created: number;
  updated: number;
  removed: number;
  drift: CommissionDrift[];
}

export interface RecordPaymentResult extends SyncResult {
  paymentId: string;
  customerId: string;
  partnerId: string;
}

type Tx = Prisma.TransactionClient;

// The default 5 s also counts the wait for the partner lock; a burst of writes for
// one partner (an import) queues behind it. Generous, but bounded.
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

interface LockedPartner {
  id: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  noticeEffectiveAt: Date | null;
}

async function lockPartner(tx: Tx, orgId: string, partnerId: string): Promise<LockedPartner> {
  const rows = await tx.$queryRaw<LockedPartner[]>`
    SELECT id, status, noticeEffectiveAt FROM \`AffiliatePartner\`
    WHERE id = ${partnerId} AND orgId = ${orgId}
    FOR UPDATE`;
  if (rows.length === 0) throw new AffiliateWriteError('partner_not_found');
  return rows[0];
}

interface LoadedPlan {
  plan: CommissionPlan;
  planVersion: number;
  planEffectiveAt: Date | null;
}

async function loadPlan(tx: Tx, orgId: string): Promise<LoadedPlan> {
  const settings = await tx.affiliateProgramSettings.findUnique({
    where: { orgId },
    select: { plan: true, planVersion: true, planEffectiveAt: true },
  });
  const parsed = settings?.plan ? parseCommissionPlan(settings.plan) : null;
  if (!settings || !parsed || !parsed.ok) throw new AffiliateWriteError('no_plan');
  return { plan: parsed.plan, planVersion: settings.planVersion, planEffectiveAt: settings.planEffectiveAt };
}

/** Runs the engine over the partner's whole history and applies the changes. Caller holds the lock. */
async function syncLocked(tx: Tx, orgId: string, partner: LockedPartner, loaded: LoadedPlan): Promise<SyncResult> {
  const { plan, planVersion, planEffectiveAt } = loaded;
  const paymentRows = await tx.affiliatePayment.findMany({
    where: { orgId, customer: { partnerId: partner.id } },
    select: { id: true, customerId: true, amountMinor: true, currency: true, receivedAt: true, createdAt: true },
  });
  const payments: PaymentFact[] = paymentRows;
  const recordedBeforePlan = new Set(
    planEffectiveAt === null ? [] : paymentRows.filter((p) => p.createdAt.getTime() < planEffectiveAt.getTime()).map((p) => p.id),
  );
  const stored: StoredCommission[] = await tx.affiliateCommission.findMany({
    where: { orgId, partnerId: partner.id },
    select: {
      id: true,
      paymentId: true,
      kind: true,
      amountMinor: true,
      currency: true,
      dueAt: true,
      windowEndsAt: true,
      planVersion: true,
      status: true,
    },
  });

  const evaluation = evaluatePartner(plan, { noticeEffectiveAt: partner.noticeEffectiveAt }, payments);
  const changes = planCommissionChanges({ evaluation, payments, stored, planVersion, recordedBeforePlan });

  if (changes.create.length > 0) {
    await tx.affiliateCommission.createMany({
      data: changes.create.map((c) => ({ ...c, orgId, partnerId: partner.id, status: 'PENDING' as const })),
    });
  }
  for (const u of changes.update) {
    // Guarded: only a still-PENDING row moves (which ones are live is the pure
    // reconciliation's decision; we hold the partner lock).
    const { count } = await tx.affiliateCommission.updateMany({
      where: { id: u.id, orgId, status: 'PENDING' },
      data: u.data,
    });
    if (count !== 1) throw new AffiliateWriteError('conflict');
  }
  if (changes.remove.length > 0) {
    const { count } = await tx.affiliateCommission.deleteMany({
      where: { id: { in: changes.remove }, orgId, status: 'PENDING' },
    });
    if (count !== changes.remove.length) throw new AffiliateWriteError('conflict');
  }
  return {
    created: changes.create.length,
    updated: changes.update.length,
    removed: changes.remove.length,
    drift: changes.drift,
  };
}

/** The audit row's detail: counts and ids only — drift is summarised, never a person's data. */
function auditDetail(fields: Record<string, unknown> & { drift?: CommissionDrift[] }): string {
  const { drift, ...rest } = fields;
  return JSON.stringify({ ...rest, ...(drift ? { drift: drift.length } : {}) });
}

/** Prisma errors a caller can act on, mapped to our codes; anything else is rethrown as is. */
function mapPrismaError(e: unknown): unknown {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return e;
  if (e.code === 'P2002') {
    // On MySQL the target is the index name, e.g. AffiliatePayment_orgId_externalPaymentRef_key.
    const target = String(e.meta?.target ?? '');
    if (target.includes('externalPaymentRef')) return new AffiliateWriteError('duplicate_payment');
    if (target.includes('externalRef')) return new AffiliateWriteError('customer_of_another_partner');
    return e;
  }
  // P2028: the transaction ran out of time (waiting for the lock counts); P2034: deadlock / write conflict.
  if (e.code === 'P2028' || e.code === 'P2034') return new AffiliateWriteError('busy');
  return e;
}

/** Records one customer payment and brings the partner's commissions in line. */
export async function recordAffiliatePayment(raw: RecordPaymentInput): Promise<RecordPaymentResult> {
  const now = raw.now ?? new Date();
  const issues = checkPaymentInput(raw, now);
  if (issues.length > 0) throw new AffiliateWriteError('invalid_input', issues);
  const input = {
    ...raw,
    customerExternalRef: normalizeRef(raw.customerExternalRef),
    externalPaymentRef: normalizeRef(raw.externalPaymentRef),
  };

  // Only to choose which partner to lock; the link is read again under the lock.
  const known = await prisma.affiliateCustomer.findUnique({
    where: { orgId_externalRef: { orgId: input.orgId, externalRef: input.customerExternalRef } },
    select: { partnerId: true },
  });
  if (known && input.partnerId && known.partnerId !== input.partnerId) throw new AffiliateWriteError('customer_of_another_partner');
  const partnerId = known?.partnerId ?? input.partnerId;
  if (!partnerId) throw new AffiliateWriteError('unknown_customer');

  try {
    return await prisma.$transaction(async (tx) => {
      const partner = await lockPartner(tx, input.orgId, partnerId);
      if (partner.status === 'SUSPENDED') throw new AffiliateWriteError('partner_suspended');
      const loaded = await loadPlan(tx, input.orgId);
      if (input.currency !== loaded.plan.currency) throw new AffiliateWriteError('currency_mismatch');

      const duplicate = await tx.affiliatePayment.findUnique({
        where: { orgId_externalPaymentRef: { orgId: input.orgId, externalPaymentRef: input.externalPaymentRef } },
        select: { id: true },
      });
      if (duplicate) throw new AffiliateWriteError('duplicate_payment');

      const current = await tx.affiliateCustomer.findUnique({
        where: { orgId_externalRef: { orgId: input.orgId, externalRef: input.customerExternalRef } },
        select: { id: true, partnerId: true },
      });
      if (current && current.partnerId !== partner.id) throw new AffiliateWriteError('customer_of_another_partner');
      const customerId =
        current?.id ??
        (
          await tx.affiliateCustomer.create({
            data: { orgId: input.orgId, partnerId: partner.id, externalRef: input.customerExternalRef },
            select: { id: true },
          })
        ).id;

      const payment = await tx.affiliatePayment.create({
        data: {
          orgId: input.orgId,
          customerId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          receivedAt: input.receivedAt,
          source: input.source,
          externalPaymentRef: input.externalPaymentRef,
          enteredById: input.enteredById ?? null,
        },
        select: { id: true },
      });

      const sync = await syncLocked(tx, input.orgId, partner, loaded);
      await tx.auditLog.create({
        data: {
          orgId: input.orgId,
          actorId: input.enteredById ?? 'system',
          action: 'affiliate.payment.record',
          targetId: payment.id,
          detail: auditDetail({
            partnerId: partner.id,
            customerId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            source: input.source,
            ...sync,
          }),
        },
      });
      return { paymentId: payment.id, customerId, partnerId: partner.id, ...sync };
    }, TX_OPTIONS);
  } catch (e) {
    throw mapPrismaError(e);
  }
}

/** Re-evaluates a partner after a plan or termination change. */
export async function resyncPartnerCommissions(orgId: string, partnerId: string, actorId: string = 'system'): Promise<SyncResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const partner = await lockPartner(tx, orgId, partnerId);
      const sync = await syncLocked(tx, orgId, partner, await loadPlan(tx, orgId));
      await tx.auditLog.create({
        data: { orgId, actorId, action: 'affiliate.commissions.resync', targetId: partner.id, detail: auditDetail({ partnerId: partner.id, ...sync }) },
      });
      return sync;
    }, TX_OPTIONS);
  } catch (e) {
    throw mapPrismaError(e);
  }
}

export interface PartnerStatePatch {
  status: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  /** Required for TERMINATED (when the termination takes effect); cleared otherwise. */
  noticeEffectiveAt?: Date | null;
}

/**
 * Changes a partner's status and termination date — they decide what accrues,
 * so they move under the same partner lock as a payment, and the partner's
 * commissions are re-evaluated in the same transaction (when a plan exists).
 *
 * ACTIVE ↔ SUSPENDED freely; either → TERMINATED with its effective date.
 * TERMINATED is FINAL (decided, docs/affiliate-module.md): no change leaves it,
 * because clearing the date would pay the termination period's payments
 * retroactively. A partner who comes back gets a new partner record.
 */
export async function changePartnerState(orgId: string, partnerId: string, patch: PartnerStatePatch, actorId: string): Promise<SyncResult | null> {
  if (patch.status === 'TERMINATED' && !(patch.noticeEffectiveAt instanceof Date && !Number.isNaN(patch.noticeEffectiveAt.getTime()))) {
    throw new AffiliateWriteError('invalid_input');
  }
  const noticeEffectiveAt = patch.status === 'TERMINATED' ? patch.noticeEffectiveAt! : null;
  try {
    return await prisma.$transaction(async (tx) => {
      const before = await lockPartner(tx, orgId, partnerId);
      if (before.status === 'TERMINATED') throw new AffiliateWriteError('invalid_transition');
      await tx.affiliatePartner.updateMany({ where: { id: partnerId, orgId }, data: { status: patch.status, noticeEffectiveAt } });
      // A partner that is no longer ACTIVE has no live invitation (#3117): a link
      // mailed before a suspension must not open the account after a reactivation.
      const { count: invitationsWithdrawn } =
        patch.status === 'ACTIVE'
          ? { count: 0 }
          : await tx.invitationToken.updateMany({
              where: { orgId, partnerId, used: false, revokedAt: null },
              data: { revokedAt: new Date() },
            });
      const settings = await tx.affiliateProgramSettings.findUnique({ where: { orgId }, select: { plan: true } });
      const sync = settings?.plan ? await syncLocked(tx, orgId, { ...before, status: patch.status, noticeEffectiveAt }, await loadPlan(tx, orgId)) : null;
      await tx.auditLog.create({
        data: {
          orgId,
          actorId,
          action: 'affiliate.partner.state',
          targetId: partnerId,
          detail: auditDetail({
            from: before.status,
            to: patch.status,
            noticeEffectiveAt: noticeEffectiveAt?.toISOString() ?? null,
            ...(invitationsWithdrawn > 0 ? { invitationsWithdrawn } : {}),
            ...(sync ?? {}),
          }),
        },
      });
      return sync;
    }, TX_OPTIONS);
  } catch (e) {
    throw mapPrismaError(e);
  }
}

export type CommissionTransition = 'APPROVE' | 'REJECT' | 'UNAPPROVE';

const TRANSITION: Record<CommissionTransition, { from: 'PENDING' | 'APPROVED'; to: 'PENDING' | 'APPROVED' | 'REJECTED' }> = {
  APPROVE: { from: 'PENDING', to: 'APPROVED' },
  REJECT: { from: 'PENDING', to: 'REJECTED' },
  // Back to PENDING before a payout: a row of the current plan version becomes a
  // projection again; an older version's stays as it is.
  UNAPPROVE: { from: 'APPROVED', to: 'PENDING' },
};

export const MAX_COMMISSIONS_PER_ACTION = 200;

/**
 * Approves, rejects or un-approves commissions. Each partner's rows move under
 * that partner's lock (so a reconciliation cannot interleave), by one guarded
 * update with the expected status in the WHERE: a row in any other state — PAID
 * above all — is never touched, and is reported as skipped. One audit row per
 * partner touched.
 */
export async function transitionCommissions(
  orgId: string,
  ids: string[],
  transition: CommissionTransition,
  actorId: string,
): Promise<{ moved: number; skipped: string[]; failedPartners: number }> {
  const unique = [...new Set(ids)].slice(0, MAX_COMMISSIONS_PER_ACTION);
  const { from, to } = TRANSITION[transition];
  const rows = await prisma.affiliateCommission.findMany({ where: { orgId, id: { in: unique } }, select: { id: true, partnerId: true } });
  const byPartner = new Map<string, string[]>();
  for (const r of rows) byPartner.set(r.partnerId, [...(byPartner.get(r.partnerId) ?? []), r.id]);

  // One transaction per partner: a partner that fails (its lock busy, a guard
  // that found another state) does not undo the others. The counts are taken
  // from what COMMITTED, and the failed partners are reported, never hidden.
  let moved = 0;
  let failedPartners = 0;
  const movedIds = new Set<string>();
  for (const [partnerId, partnerIds] of byPartner) {
    try {
      const done = await prisma.$transaction(async (tx) => {
        await lockPartner(tx, orgId, partnerId);
        const eligible = await tx.affiliateCommission.findMany({
          where: { orgId, partnerId, id: { in: partnerIds }, status: from },
          select: { id: true },
        });
        if (eligible.length === 0) return [] as string[];
        const { count } = await tx.affiliateCommission.updateMany({
          where: { orgId, partnerId, id: { in: eligible.map((e) => e.id) }, status: from },
          data: { status: to },
        });
        if (count !== eligible.length) throw new AffiliateWriteError('conflict');
        await tx.auditLog.create({
          data: {
            orgId,
            actorId,
            action: `affiliate.commission.${transition.toLowerCase()}`,
            targetId: partnerId,
            detail: JSON.stringify({ partnerId, count, commissionIds: eligible.map((e) => e.id) }),
          },
        });
        return eligible.map((e) => e.id);
      }, TX_OPTIONS);
      moved += done.length;
      for (const id of done) movedIds.add(id);
    } catch (e) {
      const mapped = mapPrismaError(e);
      if (!(mapped instanceof AffiliateWriteError)) throw mapped;
      failedPartners += 1;
    }
  }
  return { moved, skipped: unique.filter((id) => !movedIds.has(id)), failedPartners };
}

/**
 * What the engine would say today about every partner's frozen commissions —
 * read only, no lock, nothing written. The admin's "drift" list.
 */
export async function driftReport(orgId: string): Promise<(CommissionDrift & { partnerId: string })[]> {
  const settings = await prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { plan: true, planVersion: true, planEffectiveAt: true } });
  const parsed = settings?.plan ? parseCommissionPlan(settings.plan) : null;
  if (!settings || !parsed?.ok) return [];
  const partners = await prisma.affiliatePartner.findMany({ where: { orgId }, select: { id: true, noticeEffectiveAt: true } });
  const out: (CommissionDrift & { partnerId: string })[] = [];
  for (const partner of partners) {
    const paymentRows = await prisma.affiliatePayment.findMany({
      where: { orgId, customer: { partnerId: partner.id } },
      select: { id: true, customerId: true, amountMinor: true, currency: true, receivedAt: true, createdAt: true },
    });
    const stored: StoredCommission[] = await prisma.affiliateCommission.findMany({
      where: { orgId, partnerId: partner.id },
      select: { id: true, paymentId: true, kind: true, amountMinor: true, currency: true, dueAt: true, windowEndsAt: true, planVersion: true, status: true },
    });
    const effective = settings.planEffectiveAt;
    const recordedBeforePlan = new Set(effective === null ? [] : paymentRows.filter((p) => p.createdAt < effective).map((p) => p.id));
    const evaluation = evaluatePartner(parsed.plan, { noticeEffectiveAt: partner.noticeEffectiveAt }, paymentRows);
    const changes = planCommissionChanges({ evaluation, payments: paymentRows, stored, planVersion: settings.planVersion, recordedBeforePlan });
    for (const d of changes.drift) out.push({ ...d, partnerId: partner.id });
  }
  return out;
}

export interface PayoutInput {
  partnerId: string;
  commissionIds: string[];
  /** The day the bank transfer was made (a calendar day; not in the future). */
  paidAt: Date;
  reference?: string | null;
  /** Injected for tests; defaults to the wall clock (+14 h, a calendar day typed east of UTC). */
  now?: Date;
}

/**
 * Records a manual bank transfer: ALL of the given commissions — APPROVED, of this
 * partner, in one currency — become PAID and point at one new AffiliatePayout
 * whose amount is their sum. All or nothing, under the partner's lock: if any id
 * does not qualify, nothing is written (`payout_mismatch`). Audited
 * (`affiliate.payout.create`). The transfer itself happens outside the CRM.
 */
export async function createPayout(orgId: string, input: PayoutInput, actorId: string): Promise<{ payoutId: string; amountMinor: number; currency: string; count: number }> {
  const ids = [...new Set(input.commissionIds)];
  const now = input.now ?? new Date(Date.now() + 14 * 60 * 60 * 1000);
  const reference = input.reference?.trim() || null;
  if (
    ids.length === 0 ||
    ids.length > MAX_COMMISSIONS_PER_ACTION ||
    !(input.paidAt instanceof Date) ||
    Number.isNaN(input.paidAt.getTime()) ||
    input.paidAt.getTime() > now.getTime() ||
    (reference !== null && reference.length > MAX_REF_LENGTH)
  ) {
    throw new AffiliateWriteError('invalid_input');
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPartner(tx, orgId, input.partnerId);
      const rows = await tx.affiliateCommission.findMany({
        where: { orgId, partnerId: input.partnerId, id: { in: ids }, status: 'APPROVED' },
        select: { id: true, amountMinor: true, currency: true },
      });
      const currencies = new Set(rows.map((r) => r.currency));
      if (rows.length !== ids.length || currencies.size !== 1) throw new AffiliateWriteError('payout_mismatch');
      const currency = rows[0].currency;
      const amountMinor = rows.reduce((sum, r) => sum + r.amountMinor, 0);
      if (amountMinor > MAX_AMOUNT_MINOR) throw new AffiliateWriteError('payout_mismatch');

      const payout = await tx.affiliatePayout.create({
        data: { orgId, partnerId: input.partnerId, amountMinor, currency, paidAt: input.paidAt, paidById: actorId, reference },
        select: { id: true },
      });
      const { count } = await tx.affiliateCommission.updateMany({
        where: { orgId, partnerId: input.partnerId, id: { in: ids }, status: 'APPROVED' },
        data: { status: 'PAID', payoutId: payout.id, paidAt: input.paidAt },
      });
      if (count !== ids.length) throw new AffiliateWriteError('conflict');
      await tx.auditLog.create({
        data: {
          orgId,
          actorId,
          action: 'affiliate.payout.create',
          targetId: payout.id,
          detail: JSON.stringify({ partnerId: input.partnerId, count, amountMinor, currency }),
        },
      });
      return { payoutId: payout.id, amountMinor, currency, count };
    }, TX_OPTIONS);
  } catch (e) {
    throw mapPrismaError(e);
  }
}
