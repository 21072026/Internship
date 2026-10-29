'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FileField } from '@/components/ui/FileField';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import { interpolate } from '@/lib/notificationText';
import { MIGRATION_COLUMNS, type MigrationFile, type MigrationIssue, type ReconciliationRow } from '@/lib/affiliateMigrationRule';
import { AffiliateTabs } from '../AffiliateTabs';

// Taking over a previous system's affiliate history (#3118, docs/affiliate-module.md).
// Three CSV files → a dry run (issues + the reconciliation per partner) → the real
// run, offered only after a clean dry run of exactly these files. The server
// decides everything again on the real run; this page only shows it.

interface Result {
  dryRun: boolean;
  written: boolean;
  blocked: 'issues' | 'not_empty' | 'reconciliation_failed' | null;
  issues: MigrationIssue[];
  issueCount: number;
  reconciliation: ReconciliationRow[];
  counts: { partners: number; customers: number; payments: number; commissions: number; payouts: number };
}

const FILES: MigrationFile[] = ['partners', 'commissions', 'payouts'];

export default function AffiliateMigrationPage() {
  const t = useT();
  const L = t.affiliateMigration;
  const locale = useLocale();
  const toast = useToast();
  const [canWrite, setCanWrite] = useState<boolean | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [texts, setTexts] = useState<Record<MigrationFile, { name: string; text: string } | null>>({ partners: null, commissions: null, payouts: null });
  const [result, setResult] = useState<Result | null>(null);
  // The exact files the last clean dry run judged: the real run is offered for those only.
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/admin/affiliate/settings');
      if (res.status === 403) setForbidden(true);
      else if (res.ok) setCanWrite(Boolean((await res.json()).canWrite));
      else setCanWrite(false);
    })();
  }, []);

  const filesKey = JSON.stringify(FILES.map((f) => texts[f]?.text ?? ''));
  const money = (minor: number) => formatMinorAmount(minor, 'EUR', locale);

  async function pick(file: MigrationFile, list: FileList | null) {
    const f = list?.[0];
    let text: string | null = null;
    if (f) {
      try {
        // Strict: a Windows-1252 export read as UTF-8 would turn every accented
        // letter into U+FFFD, and two different names into one.
        text = new TextDecoder('utf-8', { fatal: true }).decode(await f.arrayBuffer());
      } catch {
        toast(interpolate(L.notUtf8, { file: f.name }), 'error');
      }
    }
    setTexts({ ...texts, [file]: f && text !== null ? { name: f.name, text } : null });
    setResult(null);
  }

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/affiliate/migration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partners: texts.partners?.text ?? '', commissions: texts.commissions?.text ?? '', payouts: texts.payouts?.text ?? '', dryRun }),
      });
      if (!res.ok) {
        toast(L.failed, 'error');
        return;
      }
      const body = (await res.json()) as Result;
      setResult(body);
      setCheckedKey(dryRun && body.blocked === null ? filesKey : null);
      if (body.written) toast(L.written);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (forbidden) return <p className="text-sm text-gray-600 dark:text-gray-400">{t.affiliateAdmin.noAccess}</p>;
  if (canWrite === null) return <SkeletonRows rows={4} />;

  const ready = result?.dryRun === true && result.blocked === null && checkedKey === filesKey;
  const issueText = (i: MigrationIssue) => {
    const where = [L.files[i.file], i.row ? interpolate(L.row, { n: String(i.row) }) : null, i.subject ?? null].filter(Boolean).join(' · ');
    return `${where}: ${L.issues[i.code] ?? i.code}`;
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.affiliateAdmin.title}</h1>
      <AffiliateTabs />

      <Card>
        <CardHeader>
          <CardTitle>{L.title}</CardTitle>
          <p className="text-sm text-gray-600 dark:text-gray-400">{L.intro}</p>
        </CardHeader>
        {!canWrite ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">{L.readOnly}</p>
        ) : (
          <div className="space-y-4">
            {FILES.map((f) => (
              <div key={f} className="space-y-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300" htmlFor={`migration-${f}`}>
                  {L.files[f]}
                </label>
                <FileField
                  id={`migration-${f}`}
                  accept=".csv,text/csv,text/plain"
                  chooseLabel={L.chooseFile}
                  noneLabel={L.noFileChosen}
                  fileName={texts[f]?.name ?? null}
                  onChange={(e) => void pick(f, e.target.files)}
                  data-testid={`migration-file-${f}`}
                />
                <p className="text-xs text-gray-500">
                  {L.columns}: <code className="break-all">{[...MIGRATION_COLUMNS[f].required, ...MIGRATION_COLUMNS[f].optional.map((c) => `(${c})`)].join(', ')}</code>
                </p>
              </div>
            ))}
            <p className="text-xs text-gray-500">{L.formatHint}</p>
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{L.refHint}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={busy || !texts.partners} onClick={() => void run(true)} data-testid="migration-check">
                {L.check}
              </Button>
              <Button type="button" disabled={busy || !ready} onClick={() => setConfirming(true)} data-testid="migration-run">
                {L.run}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {result && (
        <Card data-testid="migration-result">
          <CardHeader>
            <CardTitle>{result.dryRun ? L.previewTitle : L.resultTitle}</CardTitle>
            <p
              className={`text-sm ${result.blocked ? 'text-red-700 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}
              role="status"
              data-testid="migration-status"
            >
              {result.written
                ? L.statusWritten
                : result.blocked
                  ? L.blocked[result.blocked]
                  : L.statusReady}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {interpolate(L.counts, {
                partners: String(result.counts.partners),
                customers: String(result.counts.customers),
                commissions: String(result.counts.commissions),
                payouts: String(result.counts.payouts),
              })}
            </p>
          </CardHeader>

          {result.issueCount > 0 && (
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{interpolate(L.issueTitle, { n: String(result.issueCount) })}</h2>
              <ul className="max-h-72 list-disc space-y-0.5 overflow-y-auto pl-5 text-sm text-red-700 dark:text-red-400" data-testid="migration-issues">
                {result.issues.map((i, n) => (
                  <li key={n}>{issueText(i)}</li>
                ))}
              </ul>
              {result.issueCount > result.issues.length && <p className="text-xs text-gray-500">{interpolate(L.moreIssues, { n: String(result.issueCount - result.issues.length) })}</p>}
            </div>
          )}

          {result.reconciliation.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <h2 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{L.reconTitle}</h2>
              <table className="w-full text-sm" data-testid="migration-reconciliation">
                <thead className="text-left text-gray-500">
                  <tr>
                    <th className="px-3 py-2">{L.colPartner}</th>
                    <th className="px-3 py-2 text-right">{L.colPaidSource}</th>
                    <th className="px-3 py-2 text-right">{L.colPaidRows}</th>
                    <th className="px-3 py-2 text-right">{L.colUnpaidSource}</th>
                    <th className="px-3 py-2 text-right">{L.colUnpaidRows}</th>
                    <th className="px-3 py-2">{L.colMatch}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.reconciliation.map((r) => (
                    <tr key={r.code} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="px-3 py-2 font-mono">{r.code}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{money(r.expectedPaidMinor)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{money(r.paidMinor)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{money(r.expectedUnpaidMinor)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{money(r.unpaidMinor)}</td>
                      <td className="px-3 py-2">
                        <Badge variant={r.ok ? 'success' : 'danger'}>{r.ok ? L.match : L.mismatch}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={confirming}
        title={L.confirmTitle}
        message={L.confirmBody}
        confirmLabel={L.run}
        cancelLabel={L.cancel}
        loading={busy}
        onConfirm={() => void run(false)}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
