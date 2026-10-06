'use client';

import { useEffect, useMemo, useState } from 'react';
import { MailX, Upload } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ImportPreview, type PreviewReport } from '@/components/ImportPreview';
import { useT } from '@/i18n/client';
import { parseDelimited } from '@/lib/importPreview';
import { SHEETS, SHEET_FIELDS, sourceStages, suggestMapping, type Sheet } from '@/lib/migration/migrationRules';

// /admin/migrate (#2073): upload → map columns → map stages → preview →
// confirm, over POST /api/admin/migrate. Everything a person decides here is
// per-run input: the files, the column mapping (proposed from the headers by
// suggestMapping, corrected by the admin) and the stage mapping. Nothing about
// a mapping is stored. The preview is the same server code as the real run
// (src/lib/migration/runMigration.ts), so "Migrate now" writes exactly what
// the preview showed — and sends nobody an e-mail.

type SheetReport = PreviewReport & { total: number; missing: string[] };
interface Result {
  dryRun: boolean;
  sheets: Partial<Record<Sheet, SheetReport>>;
}
interface Stage {
  key: string;
  label: string;
}

export default function MigratePage() {
  const t = useT();
  const m = t.migration;
  const [texts, setTexts] = useState<Partial<Record<Sheet, string>>>({});
  const [headers, setHeaders] = useState<Partial<Record<Sheet, string[]>>>({});
  const [rowCounts, setRowCounts] = useState<Partial<Record<Sheet, number>>>({});
  const [mapping, setMapping] = useState<Partial<Record<Sheet, Record<string, string>>>>({});
  const [stageMap, setStageMap] = useState<Record<string, string>>({});
  const [stages, setStages] = useState<Stage[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/migrate')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setStages(d.stages ?? []))
      .catch(() => {});
  }, []);

  const loaded = SHEETS.filter((s) => texts[s]);
  const historyStages = useMemo(() => (texts.stageHistory ? sourceStages(texts.stageHistory, mapping.stageHistory) : []), [texts.stageHistory, mapping.stageHistory]);

  // An exact key of ours needs no mapping; everything else starts unmapped.
  useEffect(() => {
    setStageMap((prev) => {
      const next = { ...prev };
      for (const s of historyStages) if (next[s] === undefined && stages.some((st) => st.key === s)) next[s] = s;
      return next;
    });
  }, [historyStages, stages]);

  const onFile = async (sheet: Sheet, file: File | undefined) => {
    setResult(null);
    if (!file) return;
    const text = await file.text();
    const table = parseDelimited(text);
    setTexts((p) => ({ ...p, [sheet]: text }));
    setHeaders((p) => ({ ...p, [sheet]: table.header }));
    setRowCounts((p) => ({ ...p, [sheet]: table.rows.length }));
    setMapping((p) => ({ ...p, [sheet]: suggestMapping(sheet, table.header) }));
  };

  const run = async (confirm: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheets: texts,
          mapping: Object.fromEntries(loaded.map((s) => [s, Object.fromEntries(Object.entries(mapping[s] ?? {}).filter(([, col]) => col))])),
          stageMap: Object.fromEntries(Object.entries(stageMap).filter(([, to]) => to)),
          ...(confirm ? { confirm: true } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((m.errors as Record<string, string>)[body.code] ?? m.errors.generic);
        return;
      }
      setResult(body);
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  const missingAny = !!result && Object.values(result.sheets).some((r) => r && r.missing.length > 0);
  const fieldLabel = (f: string) => (m.fields as Record<string, string>)[f] ?? f;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{m.title}</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{m.intro}</p>
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800 dark:border-amber-900" data-testid="migrate-no-mail">
          <MailX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {m.noMail}
        </p>
      </div>

      {/* 1. Upload */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SHEETS.map((sheet) => (
          <Card key={sheet} className="p-4">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{m.sheets[sheet]}</h2>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{m.sheetHints[sheet]}</p>
            <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm text-blue-700 hover:underline dark:text-blue-300">
              <Upload className="h-4 w-4" aria-hidden="true" /> {m.upload}
              <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" data-testid={`migrate-upload-${sheet}`} onChange={(e) => onFile(sheet, e.target.files?.[0])} />
            </label>
            {texts[sheet] && (
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-300" data-testid={`migrate-loaded-${sheet}`}>
                {m.loaded.replace('{n}', String(rowCounts[sheet] ?? 0)).replace('{cols}', String(headers[sheet]?.length ?? 0))}
              </p>
            )}
          </Card>
        ))}
      </div>

      {/* 2. Columns */}
      {loaded.length > 0 && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{m.columnsTitle}</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{m.columnsHint}</p>
          <div className="mt-3 space-y-4">
            {loaded.map((sheet) => (
              <div key={sheet}>
                <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{m.sheets[sheet]}</h3>
                <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {SHEET_FIELDS[sheet].map(({ field, required }) => (
                    <label key={field} className="flex items-center justify-between gap-2 text-sm text-gray-700 dark:text-gray-200">
                      <span>
                        {fieldLabel(field)}
                        {required && <span className="ml-1 text-[11px] text-gray-500">({m.required})</span>}
                      </span>
                      <select
                        className="w-44 rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                        value={mapping[sheet]?.[field] ?? ''}
                        data-testid={`migrate-mapping-${sheet}-${field}`}
                        onChange={(e) => {
                          setResult(null);
                          setMapping((p) => ({ ...p, [sheet]: { ...(p[sheet] ?? {}), [field]: e.target.value } }));
                        }}
                      >
                        <option value="">{m.notMapped}</option>
                        {(headers[sheet] ?? []).map((h) => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 3. Stages */}
      {historyStages.length > 0 && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{m.stagesTitle}</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{m.stagesHint}</p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {historyStages.map((source) => (
              <label key={source} className="flex items-center justify-between gap-2 text-sm text-gray-700 dark:text-gray-200">
                <span className="truncate" title={source}>{source}</span>
                <select
                  className="w-52 rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                  value={stageMap[source] ?? ''}
                  data-testid={`migrate-stagemap-${source}`}
                  onChange={(e) => {
                    setResult(null);
                    setStageMap((p) => ({ ...p, [source]: e.target.value }));
                  }}
                >
                  <option value="">{m.stageUnmapped}</option>
                  {stages.map((st) => (
                    <option key={st.key} value={st.key}>{st.label}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </Card>
      )}

      {/* 4. Preview, 5. Confirm */}
      {loaded.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => run(false)} loading={busy} data-testid="migrate-preview">{m.preview}</Button>
          {result?.dryRun && (
            <>
              <Button onClick={() => run(true)} loading={busy} disabled={missingAny} data-testid="migrate-confirm">{m.confirm}</Button>
              <span className="text-xs text-gray-500 dark:text-gray-400">{m.confirmNote}</span>
            </>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400" data-testid="migrate-error">{error}</p>}

      {result && (
        <div className="space-y-4" data-testid="migrate-result" data-dry-run={result.dryRun ? 'true' : 'false'}>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{result.dryRun ? m.previewTitle : m.doneTitle}</h2>
          {SHEETS.filter((s) => result.sheets[s]).map((sheet) => {
            const r = result.sheets[sheet]!;
            return (
              <Card key={sheet} className="p-4" data-testid={`migrate-sheet-${sheet}`}>
                <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">{m.sheets[sheet]}</h3>
                {r.missing.length > 0 && (
                  <p className="mb-2 text-sm text-red-700 dark:text-red-400" data-testid={`migrate-missing-${sheet}`}>
                    {m.missing.replace('{fields}', r.missing.map(fieldLabel).join(', '))}
                  </p>
                )}
                <ImportPreview report={{ ...r, dryRun: result.dryRun }} reasons={m.reasons} />
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
