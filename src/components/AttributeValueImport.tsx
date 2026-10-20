'use client';

import { useState } from 'react';
import { Eye, Upload } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// The attribute-value import panel (#1920, part 2) on /admin/attributes: paste
// or pick a CSV, preview it (the same run without writes), then apply. The
// report lists every row that was not written, with its reason, so unmatched
// addresses are visible rather than silently dropped.

type Status = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'SKIP' | 'ERROR';

interface Report {
  dryRun: boolean;
  total: number;
  counts: Record<Status, number>;
  rows: { row: number; key: string; status: Status; reason?: string; changed?: string[] }[];
}

export function AttributeValueImport({ onApplied }: { onApplied: () => void }) {
  const t = useT();
  const L = t.orgAttributesAdmin.import;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'' | 'preview' | 'apply'>('');
  const [error, setError] = useState('');
  const [report, setReport] = useState<Report | null>(null);

  const messageFor = (body: { code?: string; column?: string; maxRows?: number }) => {
    const known: Record<string, string> = {
      no_email_column: L.noEmailColumn,
      unknown_column: L.unknownColumn.replace('{column}', body.column ?? ''),
      duplicate_column: L.duplicateColumn.replace('{column}', body.column ?? ''),
      no_attribute_column: L.noAttributeColumn,
      too_many_rows: L.tooManyRows.replace('{n}', String(body.maxRows ?? '')),
      file_too_large: L.fileTooLarge,
    };
    return (body.code && known[body.code]) || t.common.error;
  };

  const run = async (apply: boolean) => {
    setBusy(apply ? 'apply' : 'preview');
    setError('');
    try {
      const res = await fetch('/api/admin/attributes/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, apply }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setReport(null);
        setError(messageFor(body));
        return;
      }
      setReport(body);
      if (apply) onApplied();
    } finally {
      setBusy('');
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
    setReport(null);
  };

  const issues = report?.rows.filter((r) => r.status === 'SKIP' || r.status === 'ERROR') ?? [];

  return (
    <Card className="mb-6 max-w-4xl">
      <CardHeader>
        <CardTitle>{L.title}</CardTitle>
        <CardDescription>{L.hint}</CardDescription>
      </CardHeader>
      <div className="space-y-3">
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(e) => pickFile(e.target.files?.[0])}
          className="block text-sm text-gray-700 dark:text-gray-200"
          aria-label={L.file}
          data-testid="attribute-import-file"
        />
        <textarea
          className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          rows={6}
          placeholder={'email,department,start_date\nada@example.com,Engineering,2024-03-01'}
          aria-label={L.text}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setReport(null);
          }}
          data-testid="attribute-import-text"
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={!text.trim()} loading={busy === 'preview'} onClick={() => run(false)} data-testid="attribute-import-preview">
            <Eye className="mr-1 h-4 w-4" /> {L.preview}
          </Button>
          <Button type="button" disabled={!report?.dryRun} loading={busy === 'apply'} onClick={() => run(true)} data-testid="attribute-import-apply">
            <Upload className="mr-1 h-4 w-4" /> {L.apply}
          </Button>
        </div>
        {error && <p className="text-sm text-red-600" role="alert" data-testid="attribute-import-error">{error}</p>}
        {report && (
          <div className="space-y-2 text-sm text-gray-700 dark:text-gray-200" data-testid="attribute-import-report">
            <p className="font-medium">{report.dryRun ? L.previewResult : L.applied}</p>
            <p data-testid="attribute-import-counts">
              {L.counts
                .replace('{create}', String(report.counts.CREATE))
                .replace('{update}', String(report.counts.UPDATE))
                .replace('{unchanged}', String(report.counts.UNCHANGED))
                .replace('{skip}', String(report.counts.SKIP))
                .replace('{error}', String(report.counts.ERROR))}
            </p>
            {issues.length > 0 && (
              <ul className="max-h-60 space-y-0.5 overflow-auto text-xs" data-testid="attribute-import-issues">
                {issues.map((r) => (
                  <li key={r.row}>
                    {L.issueRow.replace('{row}', String(r.row)).replace('{email}', r.key || '—')}{' '}
                    <span className="text-gray-500">{(r.reason && (L.reasons as Record<string, string>)[r.reason]) || r.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
