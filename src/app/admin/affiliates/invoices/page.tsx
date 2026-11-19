'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FileField } from '@/components/ui/FileField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import { formatDate } from '@/lib/relativeTime';
import { interpolate } from '@/lib/notificationText';
import type { InvoiceColumns } from '@/lib/affiliateInvoiceImportRule';
import { AffiliateTabs } from '../AffiliateTabs';

// The monthly invoice CSV (#3846, docs/affiliate-module.md § Monthly invoice
// import): choose the file, say which column holds what (the last choice comes
// back), preview, import. The server decides every row on both runs — the
// preview is the same run with a writer that does not write — and this page
// only shows it. Import is offered only after a preview of exactly this file and
// these columns.

type Status = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'SKIP' | 'ERROR';
interface Row {
  row: number;
  key: string;
  status: Status;
  reason: string | null;
  customerRef: string | null;
  receivedAt: string | null;
  paidMinor: number | null;
  listAmountMinor: number | null;
  transactionCount: number | null;
}
interface Report {
  dryRun: boolean;
  total: number;
  counts: Record<Status, number>;
  truncated: boolean;
  rows: Row[];
}
type ColumnForm = Record<keyof InvoiceColumns, string>;

const EMPTY: ColumnForm = { invoiceRef: '', date: '', customerRef: '', paidAmount: '', currency: '', status: '', paidValue: '', transactions: '' };
const COLUMN_FIELDS: { field: keyof InvoiceColumns; required: boolean }[] = [
  { field: 'invoiceRef', required: true },
  { field: 'date', required: true },
  { field: 'customerRef', required: true },
  { field: 'paidAmount', required: true },
  { field: 'transactions', required: false },
  { field: 'currency', required: false },
  { field: 'status', required: false },
];
const STATUS_VARIANT: Record<Status, 'success' | 'info' | 'default' | 'warning' | 'danger'> = {
  CREATE: 'success',
  UPDATE: 'info',
  UNCHANGED: 'default',
  SKIP: 'warning',
  ERROR: 'danger',
};

const formFrom = (c: InvoiceColumns | null): ColumnForm =>
  c ? { ...EMPTY, ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v ?? ''])) } : EMPTY;

export default function AffiliateInvoicesPage() {
  const t = useT();
  const L = t.affiliateInvoices;
  const locale = useLocale();
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [header, setHeader] = useState<string[]>([]);
  const [columns, setColumns] = useState<ColumnForm>(EMPTY);
  const [issues, setIssues] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<Report | null>(null);
  // What the shown preview was made from: import is offered only for exactly that.
  const [previewOf, setPreviewOf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const signature = file ? JSON.stringify([file.text.length, file.name, columns]) : null;
  const money = (minor: number | null) => (minor === null ? '–' : formatMinorAmount(minor, 'EUR', locale));

  useEffect(() => {
    // An observer may not import: say so instead of offering a form that fails.
    void fetch('/api/admin/affiliate/settings').then(async (r) => {
      if (r.status === 403) return setForbidden(true);
      if (r.ok && (await r.json()).canWrite === false) setForbidden(true);
    });
  }, []);

  const toColumns = (f: ColumnForm) =>
    Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() === '' ? null : v]));

  async function run(dryRun: boolean, text = file?.text, chosen: ColumnForm | null = columns) {
    if (text === undefined) return;
    setBusy(true);
    setIssues(new Set());
    try {
      const res = await fetch('/api/admin/affiliate/invoices/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text, dryRun, ...(chosen ? { columns: toColumns(chosen) } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (Array.isArray(body.header)) setHeader(body.header);
      if (res.ok) {
        const next = formFrom(body.columns);
        setColumns(next);
        setReport(body);
        setPreviewOf(dryRun && file ? JSON.stringify([text.length, file.name, next]) : null);
        if (!dryRun) toast(interpolate(L.imported, { n: String(body.counts.CREATE) }));
        return;
      }
      setReport(null);
      setPreviewOf(null);
      if (body.code === 'columns') {
        if (!chosen && body.columns) setColumns(formFrom(body.columns));
        // The first look at a file with no saved choice is not an error: the selects say what is missing.
        if (chosen) {
          setIssues(new Set((body.issues ?? []).map((i: { field: string }) => i.field)));
          toast(L.chooseColumns, 'error');
        }
      } else toast(L.errors[body.code as keyof typeof L.errors] ?? L.failed, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function pick(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    const text = await f.text();
    setFile({ name: f.name, text });
    setReport(null);
    // First preview with the saved choice (none sent): the server answers with the header either way.
    await run(true, text, null);
  }

  if (forbidden) return <p className="text-sm text-gray-600 dark:text-gray-400">{t.affiliateAdmin.noAccess}</p>;

  const options = [{ value: '', label: L.columnNone }, ...header.map((h) => ({ value: h, label: h }))];
  const err = (field: string) => (issues.has(field) ? L.columnInvalid : undefined);
  const canImport = !!report && report.dryRun && previewOf !== null && previewOf === signature && report.counts.CREATE > 0 && !busy;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.affiliateAdmin.title}</h1>
      <AffiliateTabs />

      <Card>
        <CardHeader>
          <CardTitle>{L.title}</CardTitle>
          <p className="text-sm text-gray-600 dark:text-gray-400">{L.hint}</p>
        </CardHeader>
        <div className="space-y-4">
          <FileField
            id="invoice-file"
            accept=".csv,text/csv,text/plain"
            chooseLabel={L.chooseFile}
            noneLabel={L.noFile}
            fileName={file?.name ?? null}
            onChange={(e) => void pick(e.target.files)}
            data-testid="invoice-file"
          />

          {header.length > 0 && (
            <div className="space-y-3" data-testid="invoice-columns">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{L.columnsTitle}</p>
              <p className="text-xs text-gray-500">{L.columnsHint}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {COLUMN_FIELDS.map(({ field, required }) => (
                  <Select
                    key={field}
                    label={`${L.column[field]}${required ? ' *' : ''}`}
                    value={columns[field]}
                    error={err(field)}
                    onChange={(e) => setColumns({ ...columns, [field]: e.target.value })}
                    options={options}
                    data-testid={`invoice-column-${field}`}
                  />
                ))}
                {columns.status && (
                  <Input
                    label={L.column.paidValue}
                    hint={L.paidValueHint}
                    value={columns.paidValue}
                    error={err('paidValue')}
                    onChange={(e) => setColumns({ ...columns, paidValue: e.target.value })}
                    data-testid="invoice-column-paidValue"
                  />
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(true)} data-testid="invoice-preview">
                  {L.preview}
                </Button>
                <Button type="button" disabled={!canImport} onClick={() => void run(false)} data-testid="invoice-import">
                  {report && report.counts.CREATE > 0 ? interpolate(L.importN, { n: String(report.counts.CREATE) }) : L.import}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      {report && (
        <Card padding="none">
          <div className="space-y-2 p-4">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100" data-testid="invoice-report-title">
              {report.dryRun ? L.previewTitle : L.resultTitle}
            </p>
            <div className="flex flex-wrap gap-2" data-testid="invoice-counts">
              {(Object.keys(STATUS_VARIANT) as Status[])
                .filter((s) => report.counts[s] > 0)
                .map((s) => (
                  <Badge key={s} variant={STATUS_VARIANT[s]} data-testid={`invoice-count-${s}`}>
                    {interpolate(L.status[s], { n: String(report.counts[s]) })}
                  </Badge>
                ))}
            </div>
            {report.truncated && <p className="text-xs text-gray-500">{L.truncated}</p>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="invoice-rows">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="px-4 py-2">{L.colRow}</th>
                  <th className="px-4 py-2">{L.colInvoice}</th>
                  <th className="px-4 py-2">{L.colCustomer}</th>
                  <th className="px-4 py-2">{L.colDate}</th>
                  <th className="px-4 py-2 text-right">{L.colPaid}</th>
                  <th className="px-4 py-2 text-right">{L.colList}</th>
                  <th className="px-4 py-2">{L.colResult}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.row} className="border-t border-gray-100 dark:border-gray-800" data-testid="invoice-row" data-status={r.status}>
                    <td className="px-4 py-2 tabular-nums">{r.row}</td>
                    <td className="px-4 py-2 font-mono">{r.key}</td>
                    <td className="px-4 py-2 font-mono">{r.customerRef ?? '–'}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{r.receivedAt ? formatDate(r.receivedAt, locale, { timeZone: 'UTC' }) : '–'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(r.paidMinor)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {money(r.listAmountMinor)}
                      {r.listAmountMinor !== null && r.transactionCount !== null && (
                        <div className="text-xs text-gray-500">{interpolate(L.transactions, { n: new Intl.NumberFormat(locale).format(r.transactionCount) })}</div>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={STATUS_VARIANT[r.status]}>{L.rowStatus[r.status]}</Badge>
                      {r.reason && <span className="ml-2 text-xs text-gray-600 dark:text-gray-400">{L.reasons[r.reason.split(':')[0] as keyof typeof L.reasons] ?? r.reason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
