// The monthly invoice import (#3846, docs/affiliate-module.md § Monthly invoice
// import): the Prisma-aware half of src/lib/affiliateInvoiceImportRule.ts.
//
// It runs on the shared import engine (`runImport`, src/lib/importPreview.ts): a
// preview is the same run with a writer that does not write. Every payment goes
// through the ONE payment writer (`recordAffiliatePayment`, source INVOICE), so an
// imported invoice earns exactly the commission a typed one would, under the same
// partner lock, and an invoice number already recorded is refused there too.
//
// The plan, per row (the rule decides what a row SAYS, this file what it MEANS here):
//   - invoice number already recorded in this organisation → UNCHANGED (a re-upload adds nothing);
//   - the same invoice number twice in the file → the second is SKIP;
//   - a customer number no partner brought → SKIP (the file names no partner);
//   - a month for which the customer already has a payment typed BY HAND (e.g.
//     its first month, entered by transaction count before the file existed)
//     → SKIP, so that month is not counted twice. Several invoices of one month
//     from files are fine: each has its own number;
//   - otherwise CREATE. With a transaction column and a price list, the month's
//     list price is stored beside the paid amount (`listAmountMinor`): the
//     one-off commission is chosen by it, the percent earns on what was paid (#3845).
//
// The column choice is saved on the organisation after a real run, so next month
// the screen starts from it. Audited once per run with counts only.

import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { parseDelimited, runImport, type ImportReport, type PlannedRow, type RowResult } from '@/lib/importPreview';
import { DEFAULT_PLAN_TIME_ZONE, monthStartInZone, parseCommissionPlan } from '@/lib/affiliateCommissionRule';
import { listPriceMinor, readStoredPriceList } from '@/lib/affiliatePriceListRule';
import { AffiliateWriteError, recordAffiliatePayment } from '@/lib/affiliatePaymentWriter';
import {
  INVOICE_IMPORT_MAX_ROWS,
  parseInvoiceColumns,
  readStoredInvoiceColumns,
  validateInvoiceRow,
  type ColumnsIssue,
  type InvoiceColumns,
  type InvoiceRow,
} from '@/lib/affiliateInvoiceImportRule';

export interface InvoicePlan extends InvoiceRow {
  customerId: string;
  listAmountMinor: number | null;
}

export type InvoiceImportResult =
  | { ok: false; code: 'empty_file' | 'too_many_rows' | 'no_plan'; header: string[] }
  | { ok: false; code: 'columns'; header: string[]; columns: InvoiceColumns | null; issues: ColumnsIssue[] }
  | { ok: true; header: string[]; columns: InvoiceColumns; report: ImportReport<InvoicePlan> };

/** The saved column choice, or null. */
export async function savedInvoiceColumns(orgId: string): Promise<InvoiceColumns | null> {
  const row = await prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { invoiceColumns: true } });
  return readStoredInvoiceColumns(row?.invoiceColumns);
}

export async function runInvoiceImport(input: {
  orgId: string;
  actorId: string;
  csv: string;
  /** The admin's choice; absent → the saved one. */
  columns?: unknown;
  dryRun: boolean;
  now?: Date;
}): Promise<InvoiceImportResult> {
  const { orgId, actorId, dryRun } = input;
  const now = input.now ?? new Date();
  const table = parseDelimited(input.csv);
  const header = table.header;
  if (header.length === 0 || table.rows.length === 0) return { ok: false, code: 'empty_file', header };
  if (table.rows.length > INVOICE_IMPORT_MAX_ROWS) return { ok: false, code: 'too_many_rows', header };

  const settings = await prisma.affiliateProgramSettings.findUnique({
    where: { orgId },
    select: { plan: true, priceList: true, invoiceColumns: true },
  });
  const plan = settings?.plan ? parseCommissionPlan(settings.plan) : null;
  if (!plan?.ok) return { ok: false, code: 'no_plan', header };
  const currency = plan.plan.currency;
  const timeZone = plan.plan.timeZone ?? DEFAULT_PLAN_TIME_ZONE;
  const priceList = readStoredPriceList(settings?.priceList);

  const saved = readStoredInvoiceColumns(settings?.invoiceColumns);
  const parsed = parseInvoiceColumns(input.columns ?? saved, header);
  if (!parsed.ok) return { ok: false, code: 'columns', header, columns: saved, issues: parsed.issues };
  const columns = parsed.columns;

  const monthKey = (at: Date) => monthStartInZone(at, timeZone).toISOString();

  const report = await runImport<InvoiceRow, InvoicePlan>({
    parse: () => table,
    dryRun,
    validate: (row, h) => {
      const v = validateInvoiceRow(row, h, columns, now);
      if (v.ok && v.value.currency !== null && v.value.currency !== currency) {
        return { ok: false, row: v.row, key: v.key, status: 'ERROR', reason: 'currency_mismatch' };
      }
      return v;
    },
    resolve: async (rows) => {
      const refs = [...new Set(rows.map((r) => r.value.invoiceRef))];
      const customerRefs = [...new Set(rows.map((r) => r.value.customerRef))];
      const [recorded, customers] = await Promise.all([
        prisma.affiliatePayment.findMany({ where: { orgId, externalPaymentRef: { in: refs } }, select: { externalPaymentRef: true } }),
        prisma.affiliateCustomer.findMany({ where: { orgId, externalRef: { in: customerRefs } }, select: { id: true, externalRef: true, reverseCharge: true } }),
      ]);
      const recordedRefs = new Set(recorded.map((p) => p.externalPaymentRef.toLowerCase()));
      const customerBy = new Map(customers.map((c) => [c.externalRef.toLowerCase(), c]));

      // Months already typed by hand, per customer (one query over the file's span).
      const days = rows.map((r) => r.value.receivedAt.getTime());
      const manual =
        customers.length === 0
          ? []
          : await prisma.affiliatePayment.findMany({
              where: {
                orgId,
                source: 'MANUAL',
                customerId: { in: customers.map((c) => c.id) },
                receivedAt: { gte: monthStartInZone(new Date(Math.min(...days)), timeZone), lt: monthStartInZone(new Date(Math.max(...days)), timeZone, 1) },
              },
              select: { customerId: true, receivedAt: true },
            });
      const manualMonths = new Set(manual.map((p) => `${p.customerId}|${monthKey(p.receivedAt)}`));

      const seen = new Set<string>();
      const plan: PlannedRow<InvoicePlan>[] = rows.map(({ row, key, value }) => {
        const skip = (reason: string, status: 'SKIP' | 'UNCHANGED' = 'SKIP'): PlannedRow<InvoicePlan> => ({
          row,
          key,
          status,
          reason,
          value: { ...value, customerId: '', listAmountMinor: null },
        });
        const ref = value.invoiceRef.toLowerCase();
        if (recordedRefs.has(ref)) return skip('already_recorded', 'UNCHANGED');
        if (seen.has(ref)) return skip('duplicate_in_file');
        seen.add(ref);
        const customer = customerBy.get(value.customerRef.toLowerCase());
        if (!customer) return skip('unknown_customer');
        if (manualMonths.has(`${customer.id}|${monthKey(value.receivedAt)}`)) return skip('month_recorded');
        let listAmountMinor: number | null = null;
        if (value.transactionCount !== null && priceList) {
          const price = listPriceMinor(priceList, value.transactionCount, { reverseCharge: customer.reverseCharge });
          if (price.ok && price.amountMinor > 0) listAmountMinor = price.amountMinor;
        }
        return { row, key, status: 'CREATE', value: { ...value, customerId: customer.id, listAmountMinor }, targetId: customer.id };
      });
      return { plan, absent: [] };
    },
    apply: async (chunk, { dryRun: preview }) => {
      const out: RowResult<InvoicePlan>[] = [];
      for (const r of chunk) {
        if (preview || r.status !== 'CREATE') {
          out.push({ row: r.row, key: r.key, status: r.status, reason: r.reason, value: r.value, targetId: r.targetId });
          continue;
        }
        try {
          // One payment, one writer call: its own transaction under the partner lock.
          await recordAffiliatePayment({
            orgId,
            customerExternalRef: r.value.customerRef,
            amountMinor: r.value.paidMinor,
            listAmountMinor: r.value.listAmountMinor,
            transactionCount: r.value.listAmountMinor !== null ? r.value.transactionCount : null,
            currency,
            receivedAt: r.value.receivedAt,
            externalPaymentRef: r.value.invoiceRef,
            source: 'INVOICE',
            enteredById: actorId,
            now,
          });
          out.push({ row: r.row, key: r.key, status: 'CREATE', value: r.value, targetId: r.targetId });
        } catch (e) {
          if (!(e instanceof AffiliateWriteError)) throw e;
          // Recorded between the plan and the write (a second run, a typed entry): nothing new.
          if (e.code === 'duplicate_payment') out.push({ row: r.row, key: r.key, status: 'UNCHANGED', reason: 'already_recorded', value: r.value });
          else out.push({ row: r.row, key: r.key, status: 'ERROR', reason: e.issues.length > 0 ? `${e.code}:${e.issues.join(',')}` : e.code, value: r.value });
        }
      }
      return out;
    },
  });

  if (!dryRun) {
    const value = columns as unknown as Prisma.InputJsonValue;
    await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { invoiceColumns: value } });
    await prisma.auditLog.create({
      data: { orgId, actorId, action: 'affiliate.invoice_import', detail: JSON.stringify({ total: report.total, counts: report.counts }) },
    });
  }
  return { ok: true, header, columns, report };
}
