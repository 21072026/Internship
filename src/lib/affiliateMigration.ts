// Taking over a previous system's affiliate history (docs/affiliate-module.md, #3118).
// The one writer of a migration; the rules are pure in src/lib/affiliateMigrationRule.ts.
//
// It runs on the shared import engine (`runImport`, src/lib/importPreview.ts) and
// its parser — the commissions file is the engine's table, partners and payouts
// are read by the same parser — and a dry run is the same call with a writer that
// does not write. Two things differ from a row-by-row importer, on purpose:
//
// - ALL OR NOTHING. A migration is only correct as a whole (the reconciliation is
//   per partner over every row), so the whole plan is one chunk and one
//   transaction. Any issue anywhere — a bad row, a cross-file rule, a reconciliation
//   difference, a programme that already holds data — blocks it before anything is
//   written; the transaction re-checks the reconciliation and the payouts against
//   what it actually wrote and rolls back on a difference.
// - ONCE, INTO AN EMPTY PROGRAMME. A programme with any partner or payment refuses
//   it (decided: no partial merge), checked again inside the transaction.
//
// What is written: partners (codes verbatim, no account — they are invited
// afterwards), customers, payments (source IMPORT), payouts and commissions (kind
// IMPORTED, plan version 0, AS RECORDED). The payment writer never recomputes an
// IMPORT payment's commission (src/lib/affiliateCommissionSync.ts).

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { parseDelimited, runImport, type ImportReport, type ParsedTable } from '@/lib/importPreview';
import {
  MIGRATION_COLUMNS,
  MIGRATION_MAX_ROWS,
  checkMigration,
  missingColumns,
  readPartners,
  readPayouts,
  sameKey,
  validateCommissionRow,
  type MigrationCommission,
  type MigrationFile,
  type MigrationIssue,
  type MigrationIssueCode,
  type MigrationPartner,
  type MigrationPayout,
  type ReconciliationRow,
} from '@/lib/affiliateMigrationRule';
import { AFFILIATE_CURRENCIES } from '@/lib/affiliateProgramSettings';

/** Each file's size limit, in characters. */
export const MIGRATION_MAX_CHARS = 10_000_000;
const BATCH = 1_000;
const TX_OPTIONS = { maxWait: 10_000, timeout: 300_000 } as const;

export interface MigrationCounts {
  partners: number;
  customers: number;
  payments: number;
  commissions: number;
  payouts: number;
}

export type MigrationBlock = 'issues' | 'not_empty' | 'reconciliation_failed';

export interface MigrationResult {
  dryRun: boolean;
  /** True only when a real run wrote the migration. */
  written: boolean;
  blocked: MigrationBlock | null;
  issues: MigrationIssue[];
  reconciliation: ReconciliationRow[];
  /** What the set holds (dry run) or what was written (real run). */
  counts: MigrationCounts;
}

class MigrationAbort extends Error {
  constructor(readonly block: MigrationBlock) {
    super(block);
    this.name = 'MigrationAbort';
  }
}

/** An empty upload is an empty table with the file's columns, not a missing-column error. */
function table(file: MigrationFile, text: string): ParsedTable {
  if (text.trim() === '') return { header: [...MIGRATION_COLUMNS[file].required], rows: [], delimiter: ',' };
  return parseDelimited(text);
}

async function programHasData(orgId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<boolean> {
  const [partners, payments] = await Promise.all([
    client.affiliatePartner.count({ where: { orgId } }),
    client.affiliatePayment.count({ where: { orgId } }),
  ]);
  return partners > 0 || payments > 0;
}

function countsOf(partners: MigrationPartner[], commissions: MigrationCommission[], payouts: MigrationPayout[]): MigrationCounts {
  return {
    partners: partners.length,
    customers: new Set(commissions.map((c) => sameKey(c.customerRef))).size,
    payments: commissions.length,
    commissions: commissions.length,
    payouts: payouts.length,
  };
}

async function inBatches<T>(rows: T[], write: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += BATCH) await write(rows.slice(i, i + BATCH));
}

/** Writes the whole set in one transaction, or nothing. */
async function writeMigration(
  orgId: string,
  actorId: string,
  set: { partners: MigrationPartner[]; commissions: MigrationCommission[]; payouts: MigrationPayout[]; reconciliation: ReconciliationRow[] },
): Promise<MigrationCounts> {
  const currency = AFFILIATE_CURRENCIES[0];
  return prisma.$transaction(async (tx) => {
    if (await programHasData(orgId, tx)) throw new MigrationAbort('not_empty');

    await inBatches(set.partners, (batch) =>
      tx.affiliatePartner.createMany({
        data: batch.map((p) => ({ orgId, code: p.code, displayName: p.displayName, contactEmail: p.contactEmail, status: p.status, noticeEffectiveAt: p.noticeEffectiveAt })),
      }),
    );
    const partnerId = new Map((await tx.affiliatePartner.findMany({ where: { orgId }, select: { id: true, code: true } })).map((p) => [sameKey(p.code), p.id]));

    // A customer is credited from its first payment's day.
    const customers = new Map<string, { partnerKey: string; ref: string; since: Date }>();
    for (const c of set.commissions) {
      const known = customers.get(sameKey(c.customerRef));
      if (!known) customers.set(sameKey(c.customerRef), { partnerKey: sameKey(c.partnerCode), ref: c.customerRef, since: c.receivedAt });
      else if (c.receivedAt < known.since) known.since = c.receivedAt;
    }
    await inBatches([...customers.values()], (batch) =>
      tx.affiliateCustomer.createMany({ data: batch.map((c) => ({ orgId, partnerId: partnerId.get(c.partnerKey)!, externalRef: c.ref, createdAt: c.since })) }),
    );
    const customerId = new Map((await tx.affiliateCustomer.findMany({ where: { orgId }, select: { id: true, externalRef: true } })).map((c) => [sameKey(c.externalRef), c.id]));

    await inBatches(set.commissions, (batch) =>
      tx.affiliatePayment.createMany({
        data: batch.map((c) => ({
          orgId,
          customerId: customerId.get(sameKey(c.customerRef))!,
          amountMinor: c.paymentAmountMinor,
          currency,
          receivedAt: c.receivedAt,
          source: 'IMPORT' as const,
          externalPaymentRef: c.paymentRef,
          enteredById: actorId,
        })),
      }),
    );
    const paymentId = new Map((await tx.affiliatePayment.findMany({ where: { orgId }, select: { id: true, externalPaymentRef: true } })).map((p) => [sameKey(p.externalPaymentRef), p.id]));

    // A payout has no natural key of its own, so each is created and mapped by its source reference.
    const payoutOf = new Map<string, { id: string; paidAt: Date }>();
    for (const p of set.payouts) {
      const row = await tx.affiliatePayout.create({
        data: { orgId, partnerId: partnerId.get(sameKey(p.partnerCode))!, amountMinor: p.amountMinor, currency, paidAt: p.paidAt, reference: p.reference, paidById: actorId },
        select: { id: true, paidAt: true },
      });
      payoutOf.set(sameKey(p.ref), row);
    }

    await inBatches(set.commissions, (batch) =>
      tx.affiliateCommission.createMany({
        data: batch.map((c) => {
          const payout = c.payoutRef ? payoutOf.get(sameKey(c.payoutRef)) : undefined;
          return {
            orgId,
            partnerId: partnerId.get(sameKey(c.partnerCode))!,
            customerId: customerId.get(sameKey(c.customerRef))!,
            paymentId: paymentId.get(sameKey(c.paymentRef))!,
            kind: 'IMPORTED' as const,
            amountMinor: c.amountMinor,
            currency,
            accruedAt: c.receivedAt,
            dueAt: c.dueAt,
            windowEndsAt: null,
            planVersion: 0,
            status: c.status,
            payoutId: payout?.id ?? null,
            paidAt: payout?.paidAt ?? null,
          };
        }),
      }),
    );

    // Re-check against what was WRITTEN: per partner paid / unpaid, and every payout.
    const sums = await tx.affiliateCommission.groupBy({ by: ['partnerId', 'status'], where: { orgId }, _sum: { amountMinor: true } });
    const sumOf = (pid: string, statuses: string[]) => sums.filter((s) => s.partnerId === pid && statuses.includes(s.status)).reduce((n, s) => n + (s._sum.amountMinor ?? 0), 0);
    for (const r of set.reconciliation) {
      const pid = partnerId.get(sameKey(r.code))!;
      if (sumOf(pid, ['PAID']) !== r.expectedPaidMinor || sumOf(pid, ['PENDING', 'APPROVED']) !== r.expectedUnpaidMinor) {
        throw new MigrationAbort('reconciliation_failed');
      }
    }
    const payoutSums = await tx.affiliateCommission.groupBy({ by: ['payoutId'], where: { orgId, payoutId: { not: null } }, _sum: { amountMinor: true } });
    for (const p of set.payouts) {
      const id = payoutOf.get(sameKey(p.ref))!.id;
      if ((payoutSums.find((s) => s.payoutId === id)?._sum.amountMinor ?? 0) !== p.amountMinor) throw new MigrationAbort('reconciliation_failed');
    }

    const counts: MigrationCounts = { ...countsOf(set.partners, set.commissions, set.payouts), customers: customers.size };
    await tx.auditLog.create({ data: { orgId, actorId, action: 'affiliate.migration.run', detail: JSON.stringify(counts) } });
    return counts;
  }, TX_OPTIONS);
}

/** A row the engine rejected (`<column>:<code>`), as a migration issue. */
function rowIssue(row: ImportReport<MigrationCommission>['rows'][number]): MigrationIssue {
  const [subject, code] = (row.reason ?? '').split(':');
  return { file: 'commissions', row: row.row, code: (code || 'required') as MigrationIssueCode, subject };
}

export async function runAffiliateMigration(input: {
  orgId: string;
  actorId: string;
  files: Record<MigrationFile, string>;
  dryRun: boolean;
  now?: Date;
}): Promise<MigrationResult> {
  const now = input.now ?? new Date();
  const partnersRead = readPartners(table('partners', input.files.partners));
  const payoutsRead = readPayouts(table('payouts', input.files.payouts), now);
  const fileIssues: MigrationIssue[] = [...partnersRead.issues, ...payoutsRead.issues];

  let commissionRows = 0;
  let valid: MigrationCommission[] = [];
  let reconciliation: ReconciliationRow[] = [];
  let blocked: MigrationBlock | null = null;
  let written: MigrationCounts | null = null;

  const report = await runImport<MigrationCommission>({
    dryRun: input.dryRun,
    // One chunk: the migration is written whole or not at all.
    chunkSize: Number.MAX_SAFE_INTEGER,
    parse: () => {
      const t = table('commissions', input.files.commissions);
      for (const c of missingColumns('commissions', t.header)) fileIssues.push({ file: 'commissions', row: null, code: 'missing_column', subject: c });
      if (t.rows.length > MIGRATION_MAX_ROWS.commissions) fileIssues.push({ file: 'commissions', row: null, code: 'too_many_rows' });
      // A file that cannot be read as a whole is not read row by row (one issue, not thousands).
      if (fileIssues.some((i) => i.file === 'commissions')) return { ...t, rows: [] };
      commissionRows = t.rows.length;
      return t;
    },
    validate: (row, header) => validateCommissionRow(row, header, now),
    resolve: async (rows) => {
      valid = rows.map((r) => r.value);
      const check = checkMigration({ partners: partnersRead.partners, commissions: valid, payouts: payoutsRead.payouts });
      reconciliation = check.reconciliation;
      fileIssues.push(...check.issues);
      if (fileIssues.length > 0 || rows.length !== commissionRows) blocked = 'issues';
      else if (await programHasData(input.orgId)) blocked = 'not_empty';
      return {
        plan: rows.map((r) => ({ row: r.row, key: r.key, value: r.value, status: blocked ? ('SKIP' as const) : ('CREATE' as const), reason: blocked ?? undefined })),
        absent: [],
      };
    },
    apply: async (chunk, { dryRun }) => {
      if (!blocked && !dryRun) await write();
      return chunk.map((r) => ({ row: r.row, key: r.key, status: r.status, reason: r.reason }));
    },
  });

  async function write() {
    try {
      written = await writeMigration(input.orgId, input.actorId, {
        partners: partnersRead.partners,
        commissions: valid,
        payouts: payoutsRead.payouts,
        reconciliation,
      });
    } catch (e) {
      if (e instanceof MigrationAbort) blocked = e.block;
      else if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') blocked = 'not_empty'; // a concurrent migration won
      else throw e;
    }
  }

  // The engine calls `apply` once per chunk; a set without a single commission
  // has no chunk, but its partners are still a migration.
  if (!blocked && !input.dryRun && written === null && commissionRows === 0) await write();

  const issues = [...report.rows.filter((r) => r.status === 'ERROR').map(rowIssue), ...fileIssues].sort(
    (a, b) => a.file.localeCompare(b.file) || (a.row ?? 0) - (b.row ?? 0),
  );
  return {
    dryRun: input.dryRun,
    written: written !== null,
    blocked: issues.length > 0 ? 'issues' : blocked,
    issues,
    reconciliation,
    counts: written ?? countsOf(partnersRead.partners, valid, payoutsRead.payouts),
  };
}
