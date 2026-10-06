'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Pause, Play, Send, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { PremiumAnalyticsLocked } from '@/components/admin/PremiumAnalyticsLocked';
import { useLocale, useT } from '@/i18n/client';
import { REPORT_DEFINITIONS } from '@/lib/reports/definitions';
import { CADENCES, FORMATS, SUBSCRIPTION_LOCALES } from '@/lib/reportSubscriptions';

// /admin/reports/subscriptions (#1905): the org's scheduled reports. The
// rules — what is valid, who may receive, when it is due — are all server-side
// (src/lib/reportSubscriptions.ts, src/lib/reportSubscriptionAdmin.ts); this
// screen only collects the choice and shows what the API answers, including
// why a delivery was skipped.

interface Send {
  periodKey: string;
  status: 'SENT' | 'SKIPPED' | 'FAILED' | 'CLAIMED';
  error: string | null;
  sentAt: string;
}
interface Subscription {
  id: string;
  reportKey: string;
  cadence: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY';
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number;
  locale: 'en' | 'tr' | 'de';
  format: 'EMAIL_SUMMARY' | 'CSV' | 'XLSX';
  recipientEmail: string | null;
  recipientName: string | null;
  recipientUser: { id: string; fullName: string; email: string } | null;
  isActive: boolean;
  lastSentAt: string | null;
  sends: Send[];
}

function pick(obj: unknown, path: string): string {
  const v = path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
  return typeof v === 'string' ? v : path;
}

const BLANK = {
  reportKey: REPORT_DEFINITIONS[0].key,
  kind: 'external' as 'team' | 'external',
  recipientUserId: '',
  recipientEmail: '',
  recipientName: '',
  cadence: 'WEEKLY' as string,
  dayOfWeek: 1,
  dayOfMonth: 1,
  hour: 7,
  locale: 'en' as string,
  format: 'EMAIL_SUMMARY' as string,
};

export default function ReportSubscriptionsPage() {
  const t = useT();
  const locale = useLocale();
  const U = t.reportSubscriptions.ui;
  const toast = useToast();
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [people, setPeople] = useState<{ id: string; fullName: string }[]>([]);
  const [form, setForm] = useState<typeof BLANK>({ ...BLANK, locale });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Subscription | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/report-subscriptions');
    if (res.status === 403) { setLocked(true); setSubs([]); return; }
    setSubs(res.ok ? (await res.json()).subscriptions : []);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // The org's active admins and mentors — /api/users is tenant-scoped.
    const role = (r: string) =>
      fetch(`/api/users?view=picker&status=active&role=${r}`).then((x) => (x.ok ? x.json() : { users: [] })).then((d) => d.users ?? []).catch(() => []);
    Promise.all([role('ADMIN'), role('MENTOR')]).then(([a, m]) =>
      setPeople([...a, ...m].sort((x: { fullName: string }, y: { fullName: string }) => x.fullName.localeCompare(y.fullName))),
    );
  }, []);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const errorText = (code: string | undefined) => (code && (U.errors as Record<string, string>)[code]) || U.errors.generic;
  const reasonText = (code: string | null | undefined) => (code && (U.reasons as Record<string, string>)[code]) || code || '';
  const reportTitle = (key: string) => {
    const def = REPORT_DEFINITIONS.find((d) => d.key === key);
    return def ? pick(t.reports, def.titleKey) : key;
  };
  const schedule = (s: Subscription) => {
    if (s.cadence === 'WEEKLY') return U.scheduleWeekly.replace('{day}', U.weekdays[(s.dayOfWeek ?? 1) - 1]).replace('{hour}', String(s.hour).padStart(2, '0'));
    const tpl = s.cadence === 'MONTHLY' ? U.scheduleMonthly : U.scheduleQuarterly;
    return tpl.replace('{day}', String(s.dayOfMonth)).replace('{hour}', String(s.hour).padStart(2, '0'));
  };
  const date = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch('/api/admin/report-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportKey: form.reportKey,
          cadence: form.cadence,
          dayOfWeek: form.cadence === 'WEEKLY' ? form.dayOfWeek : null,
          dayOfMonth: form.cadence === 'WEEKLY' ? null : form.dayOfMonth,
          hour: form.hour,
          locale: form.locale,
          format: form.format,
          ...(form.kind === 'team'
            ? { recipientUserId: form.recipientUserId || null }
            : { recipientEmail: form.recipientEmail || null, recipientName: form.recipientName || null }),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setFormError(errorText(body.code));
        return;
      }
      toast(U.created, 'success');
      setForm({ ...BLANK, locale });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const testSend = async (s: Subscription) => {
    setBusy(s.id);
    try {
      const res = await fetch(`/api/admin/report-subscriptions/${s.id}/test`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (body.outcome === 'SENT') toast(U.testSent, 'success');
      else toast(U.testNotSent.replace('{reason}', reasonText(body.reason) || U.errors.generic), 'error');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (s: Subscription) => {
    setBusy(s.id);
    try {
      const res = await fetch(`/api/admin/report-subscriptions/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !s.isActive }),
      });
      if (!res.ok) toast(errorText((await res.json().catch(() => ({}))).code), 'error');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(deleting.id);
    try {
      await fetch(`/api/admin/report-subscriptions/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (locked) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-gray-100">{U.title}</h1>
        <PremiumAnalyticsLocked title={U.title} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{U.title}</h1>
        <p className="mt-1 text-gray-500 dark:text-gray-400">{U.subtitle}</p>
      </div>

      {subs === null ? (
        <SkeletonRows />
      ) : subs.length === 0 ? (
        <Card className="mb-6"><p className="text-sm text-gray-500 dark:text-gray-400" data-testid="report-subs-empty">{U.empty}</p></Card>
      ) : (
        <ul className="mb-6 space-y-3" data-testid="report-subs-list">
          {subs.map((s) => (
            <li key={s.id} data-testid={`report-sub-${s.id}`}>
              <Card>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 dark:text-gray-100">
                      <CalendarClock className="mr-1.5 inline h-4 w-4 align-[-2px] text-gray-400" aria-hidden />
                      {reportTitle(s.reportKey)}
                    </p>
                    <p className="mt-0.5 break-words text-sm text-gray-600 dark:text-gray-300">
                      {s.recipientUser ? s.recipientUser.fullName : s.recipientName ? `${s.recipientName} · ${s.recipientEmail}` : s.recipientEmail}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      {schedule(s)} · {U.languages[s.locale]} · {U.formats[s.format]} ·{' '}
                      <span className={s.isActive ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
                        {s.isActive ? U.active : U.paused}
                      </span>{' '}
                      · {s.lastSentAt ? U.lastSent.replace('{date}', date(s.lastSentAt)) : U.neverSent}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => testSend(s)} disabled={busy === s.id} data-testid="report-sub-test">
                      <Send className="mr-1 h-3.5 w-3.5" />{U.test}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => toggle(s)} disabled={busy === s.id} data-testid="report-sub-toggle">
                      {s.isActive ? <Pause className="mr-1 h-3.5 w-3.5" /> : <Play className="mr-1 h-3.5 w-3.5" />}
                      {s.isActive ? U.pause : U.resume}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDeleting(s)} disabled={busy === s.id} aria-label={`${U.delete}: ${reportTitle(s.reportKey)}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-gray-600 dark:text-gray-300">{U.history}</summary>
                  {s.sends.length === 0 ? (
                    <p className="mt-2 text-gray-500 dark:text-gray-400">{U.historyEmpty}</p>
                  ) : (
                    <ul className="mt-2 space-y-1" data-testid="report-sub-history">
                      {s.sends.map((h) => (
                        <li key={h.periodKey} className="text-gray-600 dark:text-gray-300">
                          <span className="font-mono text-xs">{h.periodKey.startsWith('test-') ? U.test_period : h.periodKey}</span> · {date(h.sentAt)} ·{' '}
                          <strong>{U.statuses[h.status]}</strong>
                          {h.error && h.error !== 'test' ? ` — ${reasonText(h.error)}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardHeader><CardTitle>{U.newTitle}</CardTitle></CardHeader>
        <form onSubmit={create} className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="report-sub-form">
          <Select
            label={U.report}
            value={form.reportKey}
            onChange={(e) => set('reportKey', e.target.value)}
            options={REPORT_DEFINITIONS.map((d) => ({ value: d.key, label: pick(t.reports, d.titleKey) }))}
          />
          <Select
            label={U.recipientKind}
            value={form.kind}
            onChange={(e) => set('kind', e.target.value as 'team' | 'external')}
            options={[{ value: 'external', label: U.recipientExternal }, { value: 'team', label: U.recipientTeam }]}
          />
          {form.kind === 'team' ? (
            <Select
              label={U.teamMember}
              value={form.recipientUserId}
              onChange={(e) => set('recipientUserId', e.target.value)}
              placeholder={U.pickMember}
              options={people.map((p) => ({ value: p.id, label: p.fullName }))}
            />
          ) : (
            <>
              <Input label={U.email} type="email" value={form.recipientEmail} onChange={(e) => set('recipientEmail', e.target.value)} maxLength={320} required />
              <Input label={U.name} value={form.recipientName} onChange={(e) => set('recipientName', e.target.value)} maxLength={191} />
            </>
          )}
          <Select
            label={U.cadenceLabel}
            value={form.cadence}
            onChange={(e) => set('cadence', e.target.value)}
            options={CADENCES.map((c) => ({ value: c, label: U.cadences[c] }))}
          />
          {form.cadence === 'WEEKLY' ? (
            <Select
              label={U.weekday}
              value={String(form.dayOfWeek)}
              onChange={(e) => set('dayOfWeek', Number(e.target.value))}
              options={U.weekdays.map((d, i) => ({ value: String(i + 1), label: d }))}
            />
          ) : (
            <Input label={U.dayOfMonth} type="number" min={1} max={28} value={form.dayOfMonth} onChange={(e) => set('dayOfMonth', Number(e.target.value))} />
          )}
          <Input label={U.hour} type="number" min={0} max={23} value={form.hour} onChange={(e) => set('hour', Number(e.target.value))} />
          <Select
            label={U.language}
            value={form.locale}
            onChange={(e) => set('locale', e.target.value)}
            options={SUBSCRIPTION_LOCALES.map((l) => ({ value: l, label: U.languages[l] }))}
          />
          <Select
            label={U.formatLabel}
            value={form.format}
            onChange={(e) => set('format', e.target.value)}
            options={FORMATS.map((f) => ({ value: f, label: U.formats[f] }))}
          />
          <div className="sm:col-span-2">
            {formError && <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-300" data-testid="report-sub-error">{formError}</p>}
            <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{U.floorHint}</p>
            <Button type="submit" disabled={saving}>{U.create}</Button>
          </div>
        </form>
      </Card>

      <ConfirmDialog
        open={deleting !== null}
        title={U.deleteTitle}
        message={U.deleteBody}
        confirmLabel={U.delete}
        cancelLabel={U.cancel}
        variant="danger"
        loading={busy === deleting?.id}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
