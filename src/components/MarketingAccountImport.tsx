'use client';

// The "Marketing accounts" mode of the /admin/settings import panel (#2552).
//
// A thin client for POST /api/admin/import/marketing-accounts, which runs the
// ONE marketing import engine (src/lib/marketingImportStore.ts) — the preview
// and the apply are the same request with `apply` false or true. Nothing here
// parses the file or predicts a result: the report on screen is the report the
// engine produced.
//
// Two guards are UX, not security (the route enforces the real ones):
//   • Apply stays disabled until THIS exact input (text, owner, overwrite flag)
//     has been previewed, so what is written is what was read on screen;
//   • Apply asks once — there is no un-import (docs/marketing-import.md).

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

type RowStatus = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'SKIP' | 'ERROR';
const STATUSES: RowStatus[] = ['CREATE', 'UPDATE', 'UNCHANGED', 'SKIP', 'ERROR'];

interface ReportRow {
  row: number;
  status: RowStatus;
  key: string;
  name: string | null;
  reason?: string;
  changed?: string[];
}

interface Report {
  dryRun: boolean;
  total: number;
  counts: Record<RowStatus, number>;
  /** The PII-free cutover numbers (#2555), from marketingImportMetrics(). */
  metrics?: {
    accounts: number;
    matched: number;
    withExternalId: number;
    trials: number;
    trialEnd: Record<'file' | 'kept' | 'default' | 'missing', number>;
  };
  rows: ReportRow[];
}

// -700 on white (≥ 4.5:1), -400 in dark mode — the same pairing the mentee
// import rows above use (#2131).
const STATUS_CLASS: Record<RowStatus, string> = {
  CREATE: 'text-green-700 dark:text-green-400',
  UPDATE: 'text-blue-700 dark:text-blue-400',
  UNCHANGED: 'text-gray-600 dark:text-gray-400',
  SKIP: 'text-amber-700 dark:text-amber-400',
  ERROR: 'text-red-700 dark:text-red-400',
};

export function MarketingAccountImport({
  owners,
  selfId,
}: {
  /** The org's active admins and reps (the settings page already loads them). */
  owners: { id: string; fullName: string; role: string }[];
  selfId: string | null;
}) {
  const t = useT();
  const m = t.settings.marketingImport;
  const [text, setText] = useState('');
  const [fileLabel, setFileLabel] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState('');
  const [authoritative, setAuthoritative] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [showAll, setShowAll] = useState(false);
  // The input the last successful PREVIEW ran on. Apply is offered only for it.
  const [previewedInput, setPreviewedInput] = useState<string | null>(null);

  const inputKey = `${ownerId}\u0000${authoritative ? 1 : 0}\u0000${text}`;
  const canApply = text.trim().length > 0 && previewedInput === inputKey;

  const onFile = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    try {
      setText(await file.text());
      setFileLabel(m.fileLoaded.replace('{name}', file.name).replace('{size}', String(Math.max(1, Math.round(file.size / 1024)))));
    } catch {
      setError(m.errors.read_failed);
    }
  };

  const run = async (apply: boolean) => {
    if (!text.trim()) return;
    if (apply && !window.confirm(m.confirmApply)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/import/marketing-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, apply, authoritative, ...(ownerId ? { ownerId } : {}) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setReport(null);
        const code = typeof d.code === 'string' ? d.code : res.status === 429 ? 'rate_limited' : 'generic';
        const known = m.errors[code as keyof typeof m.errors];
        setError(
          known
            ? known.replace('{n}', String(d.maxRows ?? ''))
            : typeof d.error === 'string'
              ? d.error
              : m.errors.generic,
        );
        return;
      }
      setReport(d as Report);
      setShowAll(false);
      // A preview unlocks apply for exactly this input; an apply spends it, so a
      // second apply is preceded by the re-check preview the guide asks for.
      setPreviewedInput(apply ? null : inputKey);
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  const attention = useMemo(
    () => (report ? report.rows.filter((r) => r.status === 'ERROR' || r.status === 'SKIP' || r.reason) : []),
    [report],
  );
  const shown = report ? (showAll ? report.rows : attention) : [];

  return (
    <div className="space-y-3" data-testid="marketing-import">
      <p className="text-xs text-gray-500 dark:text-gray-400">{m.hint}</p>

      <div>
        <label htmlFor="marketing-import-file" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {m.file}
        </label>
        <input
          id="marketing-import-file"
          data-testid="marketing-import-file"
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
          onChange={(e) => onFile(e.target.files?.[0])}
          className="block w-full text-sm text-gray-700 dark:text-gray-300"
        />
        {fileLabel && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{fileLabel}</p>}
      </div>

      <div>
        <label htmlFor="marketing-import-text" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {m.paste}
        </label>
        <textarea
          id="marketing-import-text"
          data-testid="marketing-import-text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setFileLabel(null);
          }}
          rows={6}
          spellCheck={false}
          placeholder={'name,country,vat_id,external_id,stage,contact_email\nNordlicht Handel GmbH,DE,DE811234567,5f00…,LEAD_QUALIFIED,lena@nordlicht.example'}
          className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="marketing-import-owner" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {m.owner}
          </label>
          <select
            id="marketing-import-owner"
            data-testid="marketing-import-owner"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">{m.ownerSelf}</option>
            {owners
              .filter((o) => o.id !== selfId)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.fullName}
                </option>
              ))}
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{m.ownerHint}</p>
        </div>
        <div>
          <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              data-testid="marketing-import-authoritative"
              checked={authoritative}
              onChange={(e) => setAuthoritative(e.target.checked)}
              className="mt-0.5"
            />
            <span>{m.authoritative}</span>
          </label>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{m.authoritativeHint}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          loading={busy}
          disabled={!text.trim()}
          onClick={() => run(false)}
          data-testid="marketing-import-preview"
        >
          {m.preview}
        </Button>
        <Button type="button" loading={busy} disabled={!canApply} onClick={() => run(true)} data-testid="marketing-import-apply">
          {m.apply}
        </Button>
        {!canApply && text.trim() && <span className="text-xs text-gray-500 dark:text-gray-400">{m.applyNeedsPreview}</span>}
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400" data-testid="marketing-import-error">
          {error}
        </p>
      )}

      {report && (
        <div className="space-y-2" data-testid="marketing-import-report" data-dry-run={report.dryRun ? 'true' : 'false'}>
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
            {report.dryRun ? m.summaryPreview : m.summaryApplied} · {m.total.replace('{n}', String(report.total))}
          </p>
          <ul className="flex flex-wrap gap-2 text-xs">
            {STATUSES.map((s) => (
              <li
                key={s}
                data-testid={`marketing-import-count-${s}`}
                data-count={report.counts[s] ?? 0}
                className="rounded-full border border-gray-200 dark:border-gray-700 px-2 py-0.5"
              >
                <span className={`font-medium ${STATUS_CLASS[s]}`}>{m.status[s]}</span> {report.counts[s] ?? 0}
              </li>
            ))}
          </ul>
          {report.metrics && (
            <p className="text-xs text-gray-600 dark:text-gray-400" data-testid="marketing-import-metrics">
              {m.metrics
                .replace('{a}', String(report.metrics.accounts))
                .replace('{m}', String(report.metrics.matched))
                .replace('{x}', String(report.metrics.withExternalId))
                .replace('{t}', String(report.metrics.trials))
                .replace('{tf}', String(report.metrics.trialEnd.file))
                .replace('{tk}', String(report.metrics.trialEnd.kept))
                .replace('{td}', String(report.metrics.trialEnd.default))
                .replace('{tm}', String(report.metrics.trialEnd.missing))}
            </p>
          )}
          {!report.dryRun && <p className="text-xs text-gray-600 dark:text-gray-400">{m.recheck}</p>}

          <div className="flex gap-2 text-xs">
            <button
              type="button"
              aria-pressed={!showAll}
              onClick={() => setShowAll(false)}
              className={`rounded px-2 py-0.5 ${!showAll ? 'bg-gray-100 dark:bg-gray-800 font-medium' : ''}`}
            >
              {m.attention} ({attention.length})
            </button>
            <button
              type="button"
              aria-pressed={showAll}
              onClick={() => setShowAll(true)}
              className={`rounded px-2 py-0.5 ${showAll ? 'bg-gray-100 dark:bg-gray-800 font-medium' : ''}`}
            >
              {m.allRows} ({report.rows.length})
            </button>
          </div>

          {shown.length > 0 && (
            <div className="max-h-80 overflow-auto border border-gray-100 dark:border-gray-800 rounded-lg">
              <table className="w-full text-xs" data-testid="marketing-import-rows">
                <thead className="text-left text-gray-500 dark:text-gray-400">
                  <tr>
                    <th scope="col" className="px-2 py-1 font-medium">{m.colRow}</th>
                    <th scope="col" className="px-2 py-1 font-medium">{m.colStatus}</th>
                    <th scope="col" className="px-2 py-1 font-medium">{m.colAccount}</th>
                    <th scope="col" className="px-2 py-1 font-medium">{m.colNote}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.row} data-testid={`marketing-import-row-${r.row}`} data-status={r.status} className="border-t border-gray-50 dark:border-gray-800 align-top">
                      <td className="px-2 py-1 text-gray-500">{r.row}</td>
                      <td className={`px-2 py-1 font-medium whitespace-nowrap ${STATUS_CLASS[r.status]}`}>{m.status[r.status] ?? r.status}</td>
                      <td className="px-2 py-1 text-gray-800 dark:text-gray-200 break-words">{r.name ?? r.key}</td>
                      <td className="px-2 py-1 text-gray-600 dark:text-gray-400 break-words">
                        {r.reason ?? (r.changed ? r.changed.join(', ') : '')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
