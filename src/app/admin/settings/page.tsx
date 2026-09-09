'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { EvaluationFrameworkEditor } from '@/components/EvaluationFrameworkEditor';
import { StageSlaEditor } from '@/components/StageSlaEditor';
import { DEFAULT_BOARD_WIP_LIMIT } from '@/lib/boardWip';

// The delivery log answers "did our mail actually go out, and when?", and a
// newsletter or announcement send writes one EmailLog row per recipient — 50
// rows all stamped "25.08.2026 16:30" cannot tell a burst apart from a stall.
// The old `toLocaleString()` here carried seconds; keep them (#1422).
const WITH_SECONDS: Intl.DateTimeFormatOptions = { second: '2-digit' };

export default function AdminSettingsPage() {
  const t = useT();
  const locale = useLocale();
  const [reminderDays, setReminderDays] = useState('14');
  const [retentionMonths, setRetentionMonths] = useState('12');
  // Notification history window (#1646) — a different thing from the one
  // above, which is about candidate records; the two hints say which is which.
  const [notificationRetentionDays, setNotificationRetentionDays] = useState('180');
  const [supportEmail, setSupportEmail] = useState('');
  const [weeklyDigest, setWeeklyDigest] = useState(true);
  const [require2fa, setRequire2fa] = useState('off');
  const [selfRegistration, setSelfRegistration] = useState('auto');
  // Negative-outcome auto-send (#830) — off by default, deliberately.
  const [outcomeAutoSend, setOutcomeAutoSend] = useState(false);
  // Blind interview review (#819) — org-wide, off by default.
  const [blindReview, setBlindReview] = useState(false);
  const [earlyAccessWindowDays, setEarlyAccessWindowDays] = useState('7');
  const [premiumAnalytics, setPremiumAnalytics] = useState(false);
  // Monthly AI call budget (#1625). A real, enforced setting — the AI gate
  // refuses calls once the month's pool is spent — that until now had no UI at
  // all, so it could only be changed with an API call or a DB write. The limit
  // resolves per tenant like every other setting, but the counter behind it
  // does not: `AiUsage` has no `orgId`, so the pool is installation-wide (see
  // docs/ai.md). The hint says that rather than promising a per-org budget.
  const [aiMonthlyQuota, setAiMonthlyQuota] = useState('200');
  // What the API resolved for this field (tenant row → global row → code
  // default). The quota is posted ONLY when it differs from this: a PUT writes
  // the caller's own layer, so posting an untouched inherited value would pin a
  // tenant override at the operator's current number, and the operator's later
  // changes to the global budget would then never reach that tenant.
  const [loadedQuota, setLoadedQuota] = useState('200');
  // Board WIP limit (#1439). Was a hardcoded 8 in the board page, which every
  // column of a large pipeline breached — so the number is the org's now, with
  // a per-stage override in the stage editor below and 0 meaning "no WIP
  // warnings at all". Same load/post dance as the quota above, for the same
  // reason: posting an untouched inherited value would pin a tenant override.
  const [boardWipLimit, setBoardWipLimit] = useState(String(DEFAULT_BOARD_WIP_LIMIT));
  const [loadedWipLimit, setLoadedWipLimit] = useState(String(DEFAULT_BOARD_WIP_LIMIT));
  const [wipLimitError, setWipLimitError] = useState<string | null>(null);
  // Monthly broadcast recipient cap (#1754). Empty = follow the plan's own
  // band; a number can only TIGHTEN it, never lift it, so a tenant admin
  // editing this box cannot raise anybody's ceiling. Same load/post dance as
  // the two above: posting an untouched inherited value would pin a tenant
  // override at the operator's current number.
  const [broadcastQuota, setBroadcastQuota] = useState('');
  const [loadedBroadcastQuota, setLoadedBroadcastQuota] = useState('');
  const [broadcastQuotaError, setBroadcastQuotaError] = useState<string | null>(null);
  // Set when the box holds something the API's `\d{1,6}` would reject (empty is
  // the common one — clearing the box is how anybody retypes a number). Without
  // this the whole PUT 400s and every other change on the form is discarded.
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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
      setNotificationRetentionDays(settings.notificationRetentionDays ?? '180');
      setSupportEmail(settings.supportEmail ?? '');
      setWeeklyDigest(settings.weeklyDigest !== 'false');
      setRequire2fa(settings.require2fa ?? 'off');
      setSelfRegistration(settings.selfRegistration ?? 'auto');
      setEarlyAccessWindowDays(settings.earlyAccessWindowDays ?? '7');
      setPremiumAnalytics(settings.premiumAnalytics === 'true');
      setAiMonthlyQuota(settings.aiMonthlyQuota ?? '200');
      setLoadedQuota(settings.aiMonthlyQuota ?? '200');
      const wip = settings.boardWipLimit ?? String(DEFAULT_BOARD_WIP_LIMIT);
      setBoardWipLimit(wip);
      setLoadedWipLimit(wip);
      setOutcomeAutoSend(settings.outcomeAutoSend === 'true');
      setBlindReview(settings.blindReview === 'true');
      const broadcast = settings.broadcastMonthlyRecipients ?? '';
      setBroadcastQuota(broadcast);
      setLoadedBroadcastQuota(broadcast);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setFlash(null); setSaveError(null); setQuotaError(null); setWipLimitError(null); setBroadcastQuotaError(null);
    // The API validates the quota with /^\d{1,6}$/ and rejects the WHOLE
    // payload on a miss, so an unusable number is caught here and reported on
    // the field instead — the rest of the form still saves.
    const quota = aiMonthlyQuota.trim();
    const quotaChanged = quota !== loadedQuota;
    if (quotaChanged && !/^\d{1,6}$/.test(quota)) {
      setQuotaError(t.settings.aiMonthlyQuotaInvalid);
      return;
    }
    // Same shape for the WIP limit: the API's `\d{1,4}` rejects the whole
    // payload on a miss, and clearing the box is how anybody retypes a number.
    const wip = boardWipLimit.trim();
    const wipChanged = wip !== loadedWipLimit;
    if (wipChanged && !/^\d{1,4}$/.test(wip)) {
      setWipLimitError(t.settings.boardWipLimitInvalid);
      return;
    }
    // The broadcast cap is the one field where EMPTY is a legal value — it
    // means "no override, follow the plan" — so only a non-empty non-number is
    // reported on the field.
    const broadcast = broadcastQuota.trim();
    const broadcastChanged = broadcast !== loadedBroadcastQuota;
    if (broadcastChanged && broadcast !== '' && !/^\d{1,7}$/.test(broadcast)) {
      setBroadcastQuotaError(t.settings.broadcastQuotaInvalid);
      return;
    }
    setSavingSettings(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminderDays, retentionMonths, notificationRetentionDays, supportEmail, weeklyDigest: weeklyDigest ? 'true' : 'false', require2fa, selfRegistration, earlyAccessWindowDays, premiumAnalytics: premiumAnalytics ? 'true' : 'false', outcomeAutoSend: outcomeAutoSend ? 'true' : 'false', blindReview: blindReview ? 'true' : 'false', ...(quotaChanged ? { aiMonthlyQuota: quota } : {}), ...(wipChanged ? { boardWipLimit: wip } : {}), ...(broadcastChanged ? { broadcastMonthlyRecipients: broadcast } : {}) }),
      });
      // A failure used to be silent: the page only reacted to `ok`, so a
      // rejected payload looked exactly like a successful save while every
      // change on the form was dropped.
      if (res.ok) { setFlash(t.settings.saved); setLoadedQuota(quota); setLoadedWipLimit(wip); setLoadedBroadcastQuota(broadcast); }
      else setSaveError(t.settings.saveFailed);
    } catch {
      setSaveError(t.settings.saveFailed);
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
      {saveError && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm" data-testid="settings-save-error">{saveError}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>{t.settings.system}</CardTitle></CardHeader>
          <form onSubmit={saveSettings} className="space-y-4">
            <Input label={t.settings.reminderDays} type="number" min={1} max={365} value={reminderDays} onChange={(e) => setReminderDays(e.target.value)} hint={t.settings.reminderDaysHint} />
            <Input label={t.settings.retentionMonths} type="number" min={1} max={120} value={retentionMonths} onChange={(e) => setRetentionMonths(e.target.value)} hint={t.settings.retentionMonthsHint} />
            {/* Immediately below retentionMonths on purpose: the two are easy to
                confuse (one is candidate records, the other in-app notification
                rows) and reading them side by side is what tells them apart. */}
            <Input label={t.settings.notificationRetentionDays} type="number" min={0} max={3650} value={notificationRetentionDays} onChange={(e) => setNotificationRetentionDays(e.target.value)} hint={t.settings.notificationRetentionDaysHint} data-testid="notification-retention-days" />
            <Input label={t.settings.supportEmail} type="email" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} />
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={weeklyDigest} onChange={(e) => setWeeklyDigest(e.target.checked)} />
              {t.settings.weeklyDigest}
            </label>
            <div>
              <label htmlFor="self-registration" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.settings.selfRegistration}</label>
              <select
                id="self-registration"
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
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.settings.blindReview}</label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={blindReview}
                  onChange={(e) => setBlindReview(e.target.checked)}
                  data-testid="blind-review"
                />
                {t.settings.blindReviewLabel}
              </label>
              <p className="text-xs text-gray-500 mt-1">{t.settings.blindReviewHint}</p>
            </div>
            <div>
              <label htmlFor="require-2fa" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.settings.require2fa}</label>
              <select
                id="require-2fa"
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
            {/* max 999999 mirrors the API's `\d{1,6}` regex, which stays the
                authority — the number attribute only keeps the form honest. */}
            <Input label={t.settings.aiMonthlyQuota} type="number" min={0} max={999999} step={1} value={aiMonthlyQuota} onChange={(e) => { setAiMonthlyQuota(e.target.value); setQuotaError(null); }} hint={t.settings.aiMonthlyQuotaHint} error={quotaError ?? undefined} data-testid="ai-monthly-quota" />
            {/* max 9999 mirrors the API's `\d{1,4}`; the per-stage override for
                this number is a row in the stage editor further down. */}
            <Input label={t.settings.boardWipLimit} type="number" min={0} max={9999} step={1} value={boardWipLimit} onChange={(e) => { setBoardWipLimit(e.target.value); setWipLimitError(null); }} hint={t.settings.boardWipLimitHint} error={wipLimitError ?? undefined} data-testid="board-wip-limit" />
            {/* Empty is a legal value here (follow the plan's band), so this
                is a text box rather than a number one — a `type="number"`
                input reports a cleared field as '' too, but reports a typo the
                same way, and the two must not be indistinguishable for a field
                whose empty state has its own meaning. */}
            <Input label={t.settings.broadcastQuota} type="text" inputMode="numeric" value={broadcastQuota} onChange={(e) => { setBroadcastQuota(e.target.value); setBroadcastQuotaError(null); }} hint={t.settings.broadcastQuotaHint} error={broadcastQuotaError ?? undefined} data-testid="broadcast-monthly-recipients" />
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
                      {/* 700, not 600, on every status colour on this page (#2131):
                          green-600 (#16a34a) is 3.3:1 on white and amber-600
                          (#d97706) 3.2:1, both under the 4.5:1 AA asks of body
                          text — axe caught the green one on the e-mail-log
                          summary below. The -700 shades are ~5:1; dark mode
                          keeps the -400 companions, which the class-strategy
                          `dark:` utility still wins on specificity. */}
                      <span className={`w-16 font-medium ${r.status === 'error' ? 'text-red-600 dark:text-red-400' : r.status === 'skip' ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400'}`}>{r.status}</span>
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
                <span className="text-green-700 dark:text-green-400">● {t.settings.smtpConnected}</span>
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
                <span className="text-green-700 dark:text-green-400">
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
                  ? t.settings.deliveryLastOk.replace('{t}', formatDateTime(emailHealth.lastOkAt, locale, WITH_SECONDS))
                  : t.settings.deliveryNeverOk}
              </span>
              {emailHealth.failuresSinceOk > 0 ? (
                <span className={emailHealth.failuresSinceOk >= 3 ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}>
                  {' · '}
                  {t.settings.deliveryFailures.replace('{n}', String(emailHealth.failuresSinceOk))}
                </span>
              ) : (
                emailHealth.lastOkAt && <span className="text-green-700 dark:text-green-400"> · {t.settings.deliveryHealthy}</span>
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
              <p className="text-sm text-green-700 dark:text-green-400">✓ {t.settings.testSent}</p>
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
                <span className="text-green-700 dark:text-green-400">{t.settings.emailLogSent.replace('{n}', String(emailLog.summary.SENT))}</span>
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
              /* tabIndex makes the scroller reachable by keyboard: the log's
                 rows do not wrap, so without it a mouse-less user cannot pan to
                 the columns past the fold. Same trade-off as the board's
                 HorizontalScrollArea — no `role="region"` to go with it, since
                 an unnamed region would only swap this violation for a
                 `region`-name one. */
              <div className="overflow-x-auto" tabIndex={0}>
                <table className="w-full text-xs" data-testid="email-log-table">
                  <tbody>
                    {emailLog.entries.map((e) => (
                      <tr key={e.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                        <td className="py-1.5 pr-2 whitespace-nowrap text-gray-400">
                          {formatDateTime(e.createdAt, locale, WITH_SECONDS)}
                        </td>
                        <td className="py-1.5 pr-2 whitespace-nowrap">
                          <span
                            className={
                              e.status === 'SENT'
                                ? 'text-green-700 dark:text-green-400'
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

      {/* Per-stage service levels (#817) — how long anyone may wait. */}
      <StageSlaEditor />
    </div>
  );
}
