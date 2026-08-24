'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { EvaluationFrameworkEditor } from '@/components/EvaluationFrameworkEditor';

export default function AdminSettingsPage() {
  const t = useT();
  const [reminderDays, setReminderDays] = useState('14');
  const [retentionMonths, setRetentionMonths] = useState('12');
  const [supportEmail, setSupportEmail] = useState('');
  const [weeklyDigest, setWeeklyDigest] = useState(true);
  const [require2fa, setRequire2fa] = useState('off');
  const [selfRegistration, setSelfRegistration] = useState('auto');
  // Negative-outcome auto-send (#830) — off by default, deliberately.
  const [outcomeAutoSend, setOutcomeAutoSend] = useState(false);
  const [earlyAccessWindowDays, setEarlyAccessWindowDays] = useState('7');
  const [premiumAnalytics, setPremiumAnalytics] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importRows, setImportRows] = useState<{
    row: number;
    email: string;
    status: string;
    reason?: string;
    // Look-alike existing candidates the API flagged for this row (#841).
    possibleDuplicates?: { id: string; fullName: string; matchedOn: string[] }[];
  }[]>([]);

  const [smtpInfo, setSmtpInfo] = useState<{
    smtp?: { ok: boolean; error?: string };
    bulkSmtp?: { configured: boolean; ok: boolean; error?: string };
    channels?: {
      primary: { host: string | null; from: string | null };
      bulk: { host: string | null; from: string | null } | null;
      bulkCategories: string[];
    };
    from?: string | null;
    host?: string | null;
  } | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; sentAt?: string } | null>(null);

  // The outbound delivery log (#1194) — the only place that can answer "did our
  // mail actually go out?". Without it a broken SMTP setup is indistinguishable
  // from users who simply never replied.
  const [emailLog, setEmailLog] = useState<{
    entries: { id: string; to: string; subject: string; category: string | null; transport: string | null; status: string; error: string | null; createdAt: string }[];
    summary: { SENT: number; FAILED: number; SKIPPED: number };
    last24h: { primary: number; bulk: number };
    byCategory: { category: string; transport: string; count: number }[];
  } | null>(null);

  // Derived delivery health (#1190): last success / failures since, computed
  // server-side from the same EmailLog ledger the table below shows.
  const [emailHealth, setEmailHealth] = useState<{
    lastOkAt: string | null;
    lastErrorAt: string | null;
    lastError: string | null;
    failuresSinceOk: number;
    attempts24h: number;
  } | null>(null);

  const loadEmailLog = useCallback(() => {
    fetch('/api/admin/email-log?limit=25').then((r) => (r.ok ? r.json() : null)).then((d) => d && setEmailLog(d)).catch(() => {});
    fetch('/api/admin/email-health').then((r) => (r.ok ? r.json() : null)).then((d) => d?.email && setEmailHealth(d.email)).catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/admin/email-test').then((r) => (r.ok ? r.json() : null)).then((d) => d && setSmtpInfo(d)).catch(() => {});
    loadEmailLog();
  }, [loadEmailLog]);

  const sendTest = async () => {
    if (!testTo.trim()) return;
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch('/api/admin/email-test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const d = await res.json();
      setTestResult(res.ok ? d : { ok: false, error: d.error ?? t.common.error });
    } catch {
      setTestResult({ ok: false, error: t.common.error });
    } finally {
      setTesting(false);
      // The probe just wrote a row; show it without a manual refresh.
      loadEmailLog();
    }
  };

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/settings');
    if (res.ok) {
      const { settings } = await res.json();
      setReminderDays(settings.reminderDays ?? '14');
      setRetentionMonths(settings.retentionMonths ?? '12');
      setSupportEmail(settings.supportEmail ?? '');
      setWeeklyDigest(settings.weeklyDigest !== 'false');
      setRequire2fa(settings.require2fa ?? 'off');
      setSelfRegistration(settings.selfRegistration ?? 'auto');
      setEarlyAccessWindowDays(settings.earlyAccessWindowDays ?? '7');
      setPremiumAnalytics(settings.premiumAnalytics === 'true');
      setOutcomeAutoSend(settings.outcomeAutoSend === 'true');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true); setFlash(null);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminderDays, retentionMonths, supportEmail, weeklyDigest: weeklyDigest ? 'true' : 'false', require2fa, selfRegistration, earlyAccessWindowDays, premiumAnalytics: premiumAnalytics ? 'true' : 'false', outcomeAutoSend: outcomeAutoSend ? 'true' : 'false' }),
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.settings.title}</h1>
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
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.settings.selfRegistration}</label>
              <select
                value={selfRegistration}
                onChange={(e) => setSelfRegistration(e.target.value)}
                className="block w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
                data-testid="self-registration-select"
              >
                <option value="auto">{t.settings.selfRegistrationAuto}</option>
                <option value="manual">{t.settings.selfRegistrationManual}</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">{t.settings.selfRegistrationHint}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.settings.outcomeAutoSend}</label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={outcomeAutoSend}
                  onChange={(e) => setOutcomeAutoSend(e.target.checked)}
                  data-testid="outcome-auto-send"
                />
                {t.settings.outcomeAutoSendLabel}
              </label>
              <p className="text-xs text-gray-500 mt-1">{t.settings.outcomeAutoSendHint}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.settings.require2fa}</label>
              <select
                value={require2fa}
                onChange={(e) => setRequire2fa(e.target.value)}
                className="block w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
              >
                <option value="off">{t.settings.require2faOff}</option>
                <option value="admins">{t.settings.require2faAdmins}</option>
                <option value="admins_mentors">{t.settings.require2faAdminsMentors}</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">{t.settings.require2faHint}</p>
            </div>
            <Input label={t.settings.earlyAccessWindow} type="number" min={0} max={365} value={earlyAccessWindowDays} onChange={(e) => setEarlyAccessWindowDays(e.target.value)} hint={t.settings.earlyAccessWindowHint} />
            <div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={premiumAnalytics} onChange={(e) => setPremiumAnalytics(e.target.checked)} />
                {t.settings.premiumAnalytics}
              </label>
              <p className="text-xs text-gray-500 mt-1">{t.settings.premiumAnalyticsHint}</p>
            </div>
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
                  <div key={r.row} className="border-b border-gray-50 last:border-0">
                    <div className="flex items-center gap-2 px-2 py-1">
                      <span className="w-6 text-gray-400">{r.row}</span>
                      <span className={`w-16 font-medium ${r.status === 'error' ? 'text-red-600' : r.status === 'skip' ? 'text-amber-600' : 'text-green-600'}`}>{r.status}</span>
                      <span className="flex-1 truncate text-gray-600">{r.email}{r.reason ? ` · ${r.reason}` : ''}</span>
                    </div>
                    {r.possibleDuplicates && r.possibleDuplicates.length > 0 && (
                      <div className="mx-2 mb-1 px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-800">
                        {t.duplicates.possibleDuplicatesTitle}:{' '}
                        {r.possibleDuplicates.map((d, i) => (
                          <span key={d.id}>
                            {i > 0 && '; '}
                            <span className="font-medium">{d.fullName}</span>
                            {' '}({t.duplicates.matchedOn}:{' '}
                            {d.matchedOn.map((s) => t.duplicates.signals[s as keyof typeof t.duplicates.signals] ?? s).join(', ')})
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>{t.settings.emailHealth}</CardTitle></CardHeader>
        <div className="space-y-3 max-w-2xl">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t.settings.emailHealthHint}</p>

          {smtpInfo && (
            <div className="text-sm">
              {smtpInfo.smtp?.ok ? (
                <span className="text-green-600 dark:text-green-400">● {t.settings.smtpConnected}</span>
              ) : (
                <span className="text-red-600 dark:text-red-400">● {t.settings.smtpFailed}{smtpInfo.smtp?.error ? `: ${smtpInfo.smtp.error}` : ''}</span>
              )}
              {smtpInfo.from && <span className="text-gray-400"> · {t.settings.sendingFrom} {smtpInfo.from}</span>}
            </div>
          )}

          {/* The second outbound channel (#1203): bulk/system mail on our own
              server so digests never eat the relay's daily allowance. */}
          {smtpInfo?.bulkSmtp && (
            <div className="text-sm">
              {!smtpInfo.bulkSmtp.configured ? (
                <span className="text-gray-400">○ {t.settings.bulkChannelOff}</span>
              ) : smtpInfo.bulkSmtp.ok ? (
                <span className="text-green-600 dark:text-green-400">
                  ● {t.settings.bulkChannelOn}
                  {smtpInfo.channels?.bulk?.from && (
                    <span className="text-gray-400"> · {t.settings.sendingFrom} {smtpInfo.channels.bulk.from}</span>
                  )}
                </span>
              ) : (
                <span className="text-red-600 dark:text-red-400">
                  ● {t.settings.bulkChannelFailed}{smtpInfo.bulkSmtp.error ? `: ${smtpInfo.bulkSmtp.error}` : ''}
                </span>
              )}
            </div>
          )}

          {emailLog?.last24h && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t.settings.quotaToday
                .replace('{p}', String(emailLog.last24h.primary))
                .replace('{b}', String(emailLog.last24h.bulk))}
            </p>
          )}

          {/* Delivery health (#1190): when did a mail last actually go out, and
              has anything failed since. Amber at 1-2 failures, red from 3 (the
              threshold that also fires the ops alert). */}
          {emailHealth && (
            <div className="text-sm" data-testid="email-delivery-health">
              <span className="text-gray-600 dark:text-gray-300">
                {emailHealth.lastOkAt
                  ? t.settings.deliveryLastOk.replace('{t}', new Date(emailHealth.lastOkAt).toLocaleString())
                  : t.settings.deliveryNeverOk}
              </span>
              {emailHealth.failuresSinceOk > 0 ? (
                <span className={emailHealth.failuresSinceOk >= 3 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}>
                  {' · '}
                  {t.settings.deliveryFailures.replace('{n}', String(emailHealth.failuresSinceOk))}
                </span>
              ) : (
                emailHealth.lastOkAt && <span className="text-green-600 dark:text-green-400"> · {t.settings.deliveryHealthy}</span>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="check-auth@verifier.port25.com"
              className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
            />
            <Button type="button" loading={testing} disabled={!testTo.trim()} onClick={sendTest}>{t.settings.sendTest}</Button>
          </div>

          {testResult && (
            testResult.ok ? (
              <p className="text-sm text-green-600 dark:text-green-400">✓ {t.settings.testSent}</p>
            ) : (
              <p className="text-sm text-red-600 dark:text-red-400">{t.settings.testFailed.replace('{e}', testResult.error ?? '')}</p>
            )
          )}

          <p className="text-xs text-gray-400">{t.settings.emailTesters}</p>

          <div className="pt-4 border-t border-gray-200 dark:border-gray-800">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{t.settings.emailLog}</h3>
              <Button type="button" variant="ghost" size="sm" onClick={loadEmailLog}>{t.settings.emailLogRefresh}</Button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t.settings.emailLogHint}</p>

            {emailLog && (
              <p className="text-xs mb-2">
                <span className="text-green-600 dark:text-green-400">{t.settings.emailLogSent.replace('{n}', String(emailLog.summary.SENT))}</span>
                {' · '}
                <span className={emailLog.summary.FAILED > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}>
                  {t.settings.emailLogFailed.replace('{n}', String(emailLog.summary.FAILED))}
                </span>
                {' · '}
                <span className={emailLog.summary.SKIPPED > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}>
                  {t.settings.emailLogSkipped.replace('{n}', String(emailLog.summary.SKIPPED))}
                </span>
              </p>
            )}

            {/* Which categories are spending the relay's allowance — so a noisy
                job can be moved to the bulk channel instead of paying more. */}
            {emailLog && emailLog.byCategory.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5" data-testid="email-category-usage">
                {emailLog.byCategory.slice(0, 8).map((c) => (
                  <span
                    key={`${c.category}-${c.transport}`}
                    className={`rounded px-1.5 py-0.5 text-[11px] ${
                      c.transport === 'bulk'
                        ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
                        : 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                    }`}
                    title={c.transport === 'bulk' ? t.settings.bulkChannelOn : t.settings.primaryChannel}
                  >
                    {c.category} {c.count}
                  </span>
                ))}
              </div>
            )}

            {emailLog && emailLog.entries.length === 0 && (
              <p className="text-xs text-gray-400">{t.settings.emailLogNone}</p>
            )}

            {emailLog && emailLog.entries.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="email-log-table">
                  <tbody>
                    {emailLog.entries.map((e) => (
                      <tr key={e.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                        <td className="py-1.5 pr-2 whitespace-nowrap text-gray-400">
                          {new Date(e.createdAt).toLocaleString()}
                        </td>
                        <td className="py-1.5 pr-2 whitespace-nowrap">
                          <span
                            className={
                              e.status === 'SENT'
                                ? 'text-green-600 dark:text-green-400'
                                : 'text-red-600 dark:text-red-400'
                            }
                          >
                            ● {e.status}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 text-gray-500 dark:text-gray-400">
                          {e.category ?? '—'}
                          {e.transport === 'bulk' && <span className="text-gray-400"> ·{t.settings.bulkTag}</span>}
                        </td>
                        <td className="py-1.5 pr-2 truncate max-w-[16rem]" title={e.to}>{e.to}</td>
                        <td className="py-1.5 text-gray-500 dark:text-gray-400 truncate max-w-[20rem]" title={e.error ?? e.subject}>
                          {e.error ?? e.subject}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* The org's competency framework (#822) — criteria as data, not code. */}
      <EvaluationFrameworkEditor />
    </div>
  );
}
