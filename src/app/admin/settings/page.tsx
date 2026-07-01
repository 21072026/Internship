'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

export default function AdminSettingsPage() {
  const t = useT();
  const [reminderDays, setReminderDays] = useState('14');
  const [retentionMonths, setRetentionMonths] = useState('12');
  const [supportEmail, setSupportEmail] = useState('');
  const [weeklyDigest, setWeeklyDigest] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importRows, setImportRows] = useState<{ row: number; email: string; status: string; reason?: string }[]>([]);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/settings');
    if (res.ok) {
      const { settings } = await res.json();
      setReminderDays(settings.reminderDays ?? '14');
      setRetentionMonths(settings.retentionMonths ?? '12');
      setSupportEmail(settings.supportEmail ?? '');
      setWeeklyDigest(settings.weeklyDigest !== 'false');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true); setFlash(null);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminderDays, retentionMonths, supportEmail, weeklyDigest: weeklyDigest ? 'true' : 'false' }),
      });
      if (res.ok) setFlash(t.settings.saved);
    } finally {
      setSavingSettings(false);
    }
  };

  const runImport = async (dryRun: boolean) => {
    if (!csv.trim()) return;
    setImporting(true); setImportResult(null); setImportRows([]);
    try {
      const res = await fetch('/api/admin/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, dryRun }),
      });
      const d = await res.json();
      if (res.ok) {
        setImportRows(d.rows ?? []);
        if (dryRun) {
          setImportResult(t.settings.dryRunResult.replace('{c}', String(d.willCreate)).replace('{s}', String(d.skipped)).replace('{e}', String(d.errors)));
        } else {
          setImportResult(t.settings.importResult.replace('{c}', String(d.created)).replace('{s}', String(d.skipped)).replace('{e}', String(d.errors)));
          setCsv('');
        }
      } else {
        setImportResult(d.error ?? t.common.error);
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.settings.title}</h1>
        <p className="text-gray-500 mt-1">{t.settings.subtitle}</p>
      </div>

      {flash && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">✓ {flash}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>{t.settings.system}</CardTitle></CardHeader>
          <form onSubmit={saveSettings} className="space-y-4">
            <Input label={t.settings.reminderDays} type="number" min={1} max={365} value={reminderDays} onChange={(e) => setReminderDays(e.target.value)} hint={t.settings.reminderDaysHint} />
            <Input label={t.settings.retentionMonths} type="number" min={1} max={120} value={retentionMonths} onChange={(e) => setRetentionMonths(e.target.value)} hint={t.settings.retentionMonthsHint} />
            <Input label={t.settings.supportEmail} type="email" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} />
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={weeklyDigest} onChange={(e) => setWeeklyDigest(e.target.checked)} />
              {t.settings.weeklyDigest}
            </label>
            <Button type="submit" loading={savingSettings}>{t.settings.save}</Button>
          </form>
          <div className="mt-6 pt-4 border-t border-gray-100">
            <p className="text-sm font-medium text-gray-700 mb-1">{t.settings.backup}</p>
            <p className="text-xs text-gray-500 mb-2">{t.settings.backupHint}</p>
            <a href="/api/account/export" className="inline-flex items-center px-3 py-1.5 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50">
              {t.settings.exportData}
            </a>
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t.settings.bulkImport}</CardTitle></CardHeader>
          <div className="space-y-3">
            <p className="text-xs text-gray-500">{t.settings.bulkImportHint}</p>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={8}
              placeholder={'fullName,email,phone,university,department\nAyşe Yılmaz,ayse@example.com,,Boğaziçi,CS'}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
            />
            <div className="flex gap-2">
              <Button type="button" variant="outline" loading={importing} disabled={!csv.trim()} onClick={() => runImport(true)}>{t.settings.preview}</Button>
              <Button type="button" loading={importing} disabled={!csv.trim()} onClick={() => runImport(false)}>{t.settings.import}</Button>
            </div>
            {importResult && <p className="text-sm text-gray-700">{importResult}</p>}
            {importRows.length > 0 && (
              <div className="max-h-56 overflow-y-auto border border-gray-100 rounded-lg text-xs">
                {importRows.map((r) => (
                  <div key={r.row} className="flex items-center gap-2 px-2 py-1 border-b border-gray-50 last:border-0">
                    <span className="w-6 text-gray-400">{r.row}</span>
                    <span className={`w-16 font-medium ${r.status === 'error' ? 'text-red-600' : r.status === 'skip' ? 'text-amber-600' : 'text-green-600'}`}>{r.status}</span>
                    <span className="flex-1 truncate text-gray-600">{r.email}{r.reason ? ` · ${r.reason}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
