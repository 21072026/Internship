'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, Pencil, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTimeWithZone } from '@/lib/relativeTime';
import { viewerTimeZone } from '@/lib/timezone';
import { parseDelimited } from '@/lib/importPreview';
import {
  ROSTER_DEPROVISION_DEFAULTS,
  ROSTER_KEY_FIELDS,
  ROSTER_MAPPABLE_FIELDS,
  ROSTER_TRANSPORTS,
  nextCronRun,
  type RosterColumnMap,
  type RosterMappableField,
} from '@/lib/rosterFeed';

// The roster feeds console (#1967): what each feed is, when it runs, what its
// last run did, and every row it touched. Schedules are stored and evaluated in
// UTC and shown in the viewer's own zone. Authorization is the API's — every
// route under /api/admin/roster-feeds checks the session and the org; nothing
// on this page is a control.

interface RunSummary {
  id: string;
  status: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  rowCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
  errorCount: number;
  deactivatedCount: number;
  reactivatedCount: number;
  safetyReason: string | null;
  error: string | null;
  acknowledgedAt: string | null;
}

interface Feed {
  id: string;
  name: string;
  transport: string;
  enabled: boolean;
  url: string | null;
  sftpHost: string | null;
  sftpPort: number | null;
  sftpUsername: string | null;
  sftpPath: string | null;
  sftpHostKeyFingerprint: string | null;
  delimiter: string | null;
  keyField: string;
  columnMap: RosterColumnMap;
  authoritative: boolean;
  cronExpression: string | null;
  deprovision: boolean;
  maxDeactivatePercent: number;
  minRowCount: number;
  deprovisionGraceDays: number;
  pausedReason: string | null;
  secretSet: boolean;
  nextRunAt: string | null;
  lastRun: RunSummary | null;
}

interface RowResult {
  rowNumber: number;
  key: string;
  status: string;
  message: string | null;
}

interface Draft {
  name: string;
  transport: string;
  url: string;
  sftpHost: string;
  sftpPort: string;
  sftpUsername: string;
  sftpPath: string;
  sftpHostKeyFingerprint: string;
  secret: string;
  clearSecret: boolean;
  delimiter: string;
  keyField: string;
  columnMap: RosterColumnMap;
  authoritative: boolean;
  enabled: boolean;
  cronExpression: string;
  deprovision: boolean;
  maxDeactivatePercent: string;
  minRowCount: string;
  deprovisionGraceDays: string;
}

const emptyDraft = (): Draft => ({
  name: '',
  transport: 'HTTPS',
  url: '',
  sftpHost: '',
  sftpPort: '',
  sftpUsername: '',
  sftpPath: '',
  sftpHostKeyFingerprint: '',
  secret: '',
  clearSecret: false,
  delimiter: '',
  keyField: 'EMAIL',
  columnMap: {},
  authoritative: false,
  enabled: false,
  cronExpression: '0 3 * * *',
  deprovision: false,
  maxDeactivatePercent: String(ROSTER_DEPROVISION_DEFAULTS.maxDeactivatePercent),
  minRowCount: String(ROSTER_DEPROVISION_DEFAULTS.minRowCount),
  deprovisionGraceDays: String(ROSTER_DEPROVISION_DEFAULTS.deprovisionGraceDays),
});

const draftOf = (f: Feed): Draft => ({
  name: f.name,
  transport: f.transport,
  url: f.url ?? '',
  sftpHost: f.sftpHost ?? '',
  sftpPort: f.sftpPort ? String(f.sftpPort) : '',
  sftpUsername: f.sftpUsername ?? '',
  sftpPath: f.sftpPath ?? '',
  sftpHostKeyFingerprint: f.sftpHostKeyFingerprint ?? '',
  secret: '',
  clearSecret: false,
  delimiter: f.delimiter ?? '',
  keyField: f.keyField,
  columnMap: f.columnMap ?? {},
  authoritative: f.authoritative,
  enabled: f.enabled,
  cronExpression: f.cronExpression ?? '',
  deprovision: f.deprovision,
  maxDeactivatePercent: String(f.maxDeactivatePercent),
  minRowCount: String(f.minRowCount),
  deprovisionGraceDays: String(f.deprovisionGraceDays),
});

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

const STATUS_VARIANT: Record<string, 'success' | 'danger' | 'warning' | 'info' | 'default'> = {
  SUCCEEDED: 'success',
  FAILED: 'danger',
  ABORTED_SAFETY: 'warning',
  RUNNING: 'info',
  NOOP: 'default',
};

export default function AdminRosterFeedsPage() {
  const t = useT();
  const locale = useLocale();
  const L = t.rosterFeedsAdmin;
  const zone = useMemo(() => viewerTimeZone(), []);
  const when = useCallback((d: string | Date) => formatDateTimeWithZone(d, locale, zone), [locale, zone]);
  const statusLabel = (s: string) => (L as Record<string, string>)[`status_${s}`] ?? s;
  const actionLabel = (s: string) => (L as Record<string, string>)[`action_${s}`] ?? s;
  const fieldLabel = (f: RosterMappableField) => (L as Record<string, string>)[`field_${f}`] ?? f;

  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [sampleHeader, setSampleHeader] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Feed | null>(null);
  const [pendingApprove, setPendingApprove] = useState<{ feed: Feed; run: RunSummary } | null>(null);
  const [historyFeed, setHistoryFeed] = useState<Feed | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<{ feed: Feed; run: RunSummary } | null>(null);
  const [rows, setRows] = useState<RowResult[]>([]);
  const [rowFilter, setRowFilter] = useState('');
  const [rowPage, setRowPage] = useState(1);
  const [rowTotal, setRowTotal] = useState(0);
  const [rowPageSize, setRowPageSize] = useState(50);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/roster-feeds');
    if (res.ok) setFeeds((await res.json()).feeds);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const loadRuns = useCallback(async (feed: Feed) => {
    const res = await fetch(`/api/admin/roster-feeds/${feed.id}/runs`);
    if (res.ok) setRuns((await res.json()).runs);
  }, []);

  // Only the newest request may set the table: a slower earlier one (a
  // filter changed mid-flight) must not overwrite the answer to a later one.
  const rowsRequest = useRef(0);
  const loadRows = useCallback(async (feed: Feed, run: RunSummary, status: string, page: number) => {
    const seq = ++rowsRequest.current;
    const q = new URLSearchParams({ page: String(page) });
    if (status) q.set('status', status);
    const res = await fetch(`/api/admin/roster-feeds/${feed.id}/runs/${run.id}?${q}`);
    if (!res.ok || seq !== rowsRequest.current) return;
    const body = await res.json();
    if (seq !== rowsRequest.current) return;
    setRows(body.rows);
    setRowTotal(body.total);
    setRowPageSize(body.pageSize);
  }, []);

  useEffect(() => {
    if (detail) loadRows(detail.feed, detail.run, rowFilter, rowPage);
  }, [detail, rowFilter, rowPage, loadRows]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const readSample = (text: string) => {
    if (!text.trim()) return setSampleHeader([]);
    const table = parseDelimited(text.split(/\r?\n/).slice(0, 20).join('\n'), {
      delimiter: draft.delimiter || undefined,
    });
    setSampleHeader(table.header.map((h) => h.trim()).filter(Boolean));
  };

  const openCreate = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setSampleHeader([]);
    setFieldErrors({});
    setError('');
    setFormOpen(true);
  };
  const openEdit = (f: Feed) => {
    setEditingId(f.id);
    setDraft(draftOf(f));
    setSampleHeader([]);
    setFieldErrors({});
    setError('');
    setFormOpen(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setError('');
    setFieldErrors({});
    const body: Record<string, unknown> = {
      ...draft,
      sftpPort: draft.sftpPort || null,
      cronExpression: draft.cronExpression || null,
      delimiter: draft.delimiter || null,
      secret: draft.secret || undefined,
      clearSecret: draft.clearSecret || undefined,
    };
    const res = await fetch(editingId ? `/api/admin/roster-feeds/${editingId}` : '/api/admin/roster-feeds', {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy('');
    if (res.ok) {
      setFormOpen(false);
      await load();
      return;
    }
    const data = await res.json().catch(() => ({}));
    const errs: Record<string, string> = {};
    for (const err of (data.errors ?? []) as { field: string; code: string }[]) {
      errs[err.field] = (L as Record<string, string>)[`err_${err.code}`] ?? err.code;
    }
    setFieldErrors(errs);
    setError(data.errors ? L.validationFailed : data.error ?? L.validationFailed);
  };

  const remove = async (f: Feed) => {
    await fetch(`/api/admin/roster-feeds/${f.id}`, { method: 'DELETE' });
    setPendingDelete(null);
    if (historyFeed?.id === f.id) setHistoryFeed(null);
    await load();
  };

  const run = async (f: Feed, dryRun: boolean) => {
    setBusy(`${dryRun ? 'dry' : 'run'}-${f.id}`);
    setNotice('');
    const res = await fetch(`/api/admin/roster-feeds/${f.id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy('');
    if (res.status === 409) setNotice(L.alreadyRunning);
    else if (!res.ok) setNotice(data.error ?? statusLabel('FAILED'));
    else if (dryRun && data.counts) {
      setNotice(
        fill(L.dryRunDone, {
          created: data.counts.CREATE,
          updated: data.counts.UPDATE,
          unchanged: data.counts.UNCHANGED,
          errors: data.counts.ERROR,
        }),
      );
    } else setNotice(fill(L.runDone, { status: statusLabel(data.status ?? data.outcome) }));
    await load();
    if (historyFeed?.id === f.id) await loadRuns(f);
  };

  const approve = async (f: Feed, r: RunSummary) => {
    setPendingApprove(null);
    setBusy(`approve-${r.id}`);
    const res = await fetch(`/api/admin/roster-feeds/${f.id}/runs/${r.id}/approve`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    setBusy('');
    setNotice(res.ok ? fill(L.runDone, { status: statusLabel(data.status ?? data.outcome) }) : data.error ?? '');
    await load();
    await loadRuns(f);
  };

  const acknowledge = async (f: Feed, r: RunSummary) => {
    await fetch(`/api/admin/roster-feeds/${f.id}/runs/${r.id}/acknowledge`, { method: 'POST' });
    await load();
  };

  const openHistory = async (f: Feed) => {
    setHistoryFeed(f);
    setDetail(null);
    await loadRuns(f);
  };

  const openDetail = (f: Feed, r: RunSummary) => {
    setRowFilter('');
    setRowPage(1);
    setDetail({ feed: f, run: r });
  };

  const summary = (r: RunSummary) =>
    fill(L.summary, {
      created: r.createdCount,
      updated: r.updatedCount,
      unchanged: r.unchangedCount,
      skipped: r.skippedCount,
      errors: r.errorCount,
      deactivated: r.deactivatedCount,
      reactivated: r.reactivatedCount,
    });

  const banners = feeds.filter(
    (f) => f.lastRun && !f.lastRun.acknowledgedAt && (f.lastRun.status === 'FAILED' || f.lastRun.status === 'ABORTED_SAFETY'),
  );
  const cronPreview = draft.cronExpression.trim() ? nextCronRun(draft.cronExpression, new Date()) : null;
  const pages = Math.max(1, Math.ceil(rowTotal / rowPageSize));

  const columnControl = (field: RosterMappableField) => {
    const value = draft.columnMap[field] ?? '';
    const setColumn = (v: string) => set('columnMap', { ...draft.columnMap, [field]: v || undefined });
    const err = fieldErrors[`columnMap.${field}`];
    if (sampleHeader.length) {
      const inSample = !value || sampleHeader.includes(value);
      return (
        <Select
          key={field}
          label={fieldLabel(field)}
          value={value}
          onChange={(e) => setColumn(e.target.value)}
          options={[
            { value: '', label: L.notMapped },
            ...(!inSample ? [{ value, label: `${value} (${L.columnNotFound})` }] : []),
            ...sampleHeader.map((h) => ({ value: h, label: h })),
          ]}
          error={err}
          data-testid={`column-${field}`}
        />
      );
    }
    return (
      <Input
        key={field}
        label={fieldLabel(field)}
        value={value}
        onChange={(e) => setColumn(e.target.value)}
        error={err}
        data-testid={`column-${field}`}
      />
    );
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>
          <p className="mt-1 max-w-3xl text-gray-500">{L.subtitle}</p>
        </div>
        <Button type="button" onClick={openCreate} data-testid="roster-feed-new">
          <Plus className="mr-1 h-4 w-4" /> {L.newFeed}
        </Button>
      </div>

      {banners.map((f) => (
        <div
          key={f.id}
          role="alert"
          className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          data-testid={`roster-banner-${f.id}`}
        >
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {fill(f.lastRun!.status === 'FAILED' ? L.bannerFailed : L.bannerAborted, {
              name: f.name,
              reason: f.lastRun!.safetyReason ?? f.lastRun!.error ?? statusLabel(f.lastRun!.status),
            })}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={() => acknowledge(f, f.lastRun!)}>
            {L.acknowledge}
          </Button>
        </div>
      ))}

      {notice && (
        <p className="mb-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-800" role="status" data-testid="roster-notice">
          {notice}
        </p>
      )}

      {formOpen && (
        <Card className="mb-6 max-w-4xl">
          <CardHeader>
            <CardTitle>{editingId ? L.editFeed : L.newFeed}</CardTitle>
          </CardHeader>
          <form onSubmit={save} className="space-y-5" data-testid="roster-feed-form">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input label={L.name} value={draft.name} onChange={(e) => set('name', e.target.value)} error={fieldErrors.name} data-testid="feed-name" />
              <Select
                label={L.transport}
                value={draft.transport}
                onChange={(e) => set('transport', e.target.value)}
                options={ROSTER_TRANSPORTS.map((v) => ({ value: v, label: v }))}
              />
            </div>

            {draft.transport === 'HTTPS' ? (
              <Input label={L.url} value={draft.url} onChange={(e) => set('url', e.target.value)} error={fieldErrors.url} data-testid="feed-url" />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input label={L.sftpHost} value={draft.sftpHost} onChange={(e) => set('sftpHost', e.target.value)} error={fieldErrors.sftpHost} />
                <Input label={L.sftpPort} inputMode="numeric" value={draft.sftpPort} onChange={(e) => set('sftpPort', e.target.value)} error={fieldErrors.sftpPort} />
                <Input label={L.sftpUsername} value={draft.sftpUsername} onChange={(e) => set('sftpUsername', e.target.value)} error={fieldErrors.sftpUsername} />
                <Input label={L.sftpPath} value={draft.sftpPath} onChange={(e) => set('sftpPath', e.target.value)} error={fieldErrors.sftpPath} />
                <div className="sm:col-span-2">
                  <Input
                    label={L.sftpHostKeyFingerprint}
                    hint={L.sftpHostKeyHint}
                    value={draft.sftpHostKeyFingerprint}
                    onChange={(e) => set('sftpHostKeyFingerprint', e.target.value)}
                    error={fieldErrors.sftpHostKeyFingerprint}
                  />
                </div>
              </div>
            )}

            <div>
              <Input
                label={L.secret}
                type="password"
                autoComplete="new-password"
                value={draft.secret}
                onChange={(e) => set('secret', e.target.value)}
                hint={editingId && feeds.find((f) => f.id === editingId)?.secretSet ? L.secretSet : L.secretNotSet}
                error={fieldErrors.secret}
              />
              {editingId && feeds.find((f) => f.id === editingId)?.secretSet && (
                <label className="mt-2 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                  <input type="checkbox" checked={draft.clearSecret} onChange={(e) => set('clearSecret', e.target.checked)} />
                  {L.clearSecret}
                </label>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label={L.schedule}
                hint={L.scheduleHint}
                value={draft.cronExpression}
                onChange={(e) => set('cronExpression', e.target.value)}
                error={fieldErrors.cronExpression}
                data-testid="feed-cron"
              />
              <div className="self-center text-sm text-gray-600 dark:text-gray-300" data-testid="feed-cron-preview">
                {cronPreview ? fill(L.nextRunAt, { when: when(cronPreview) }) : draft.cronExpression.trim() ? '' : L.noSchedule}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                label={L.keyField}
                value={draft.keyField}
                onChange={(e) => set('keyField', e.target.value)}
                options={ROSTER_KEY_FIELDS.map((v) => ({ value: v, label: v === 'EMAIL' ? L.keyEmail : L.keyExternalId }))}
              />
              <Select
                label={L.delimiter}
                value={draft.delimiter}
                onChange={(e) => set('delimiter', e.target.value)}
                options={[
                  { value: '', label: L.delimiterAuto },
                  { value: ',', label: ',' },
                  { value: ';', label: ';' },
                  { value: '\t', label: 'Tab' },
                  { value: '|', label: '|' },
                ]}
                error={fieldErrors.delimiter}
              />
            </div>

            <fieldset className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
              <legend className="px-1 text-sm font-semibold text-gray-800 dark:text-gray-100">{L.columns}</legend>
              <p className="text-xs text-gray-500">{L.columnsHint}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="font-medium text-gray-700 dark:text-gray-200">{L.sample}</span>
                  <input
                    type="file"
                    accept=".csv,.txt,text/csv,text/plain"
                    className="mt-1 block w-full text-sm"
                    data-testid="feed-sample-file"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) readSample(await file.slice(0, 64 * 1024).text());
                    }}
                  />
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-gray-700 dark:text-gray-200">{L.samplePaste}</span>
                  <textarea
                    rows={3}
                    className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                    data-testid="feed-sample-paste"
                    onChange={(e) => readSample(e.target.value)}
                  />
                </label>
              </div>
              {sampleHeader.length > 0 && (
                <p className="text-xs text-gray-600 dark:text-gray-300" data-testid="feed-sample-columns">
                  {fill(L.sampleColumns, { n: sampleHeader.length })}
                </p>
              )}
              {fieldErrors.columnMap && <p className="text-sm text-red-600">{fieldErrors.columnMap}</p>}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{ROSTER_MAPPABLE_FIELDS.map(columnControl)}</div>
            </fieldset>

            <fieldset className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
              <label className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                <input type="checkbox" checked={draft.deprovision} onChange={(e) => set('deprovision', e.target.checked)} data-testid="feed-deprovision" />
                {L.deprovision}
              </label>
              <p className="text-xs text-gray-500">{L.deprovisionHint}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Input label={L.maxDeactivatePercent} inputMode="numeric" value={draft.maxDeactivatePercent} onChange={(e) => set('maxDeactivatePercent', e.target.value)} error={fieldErrors.maxDeactivatePercent} />
                <Input label={L.minRowCount} inputMode="numeric" value={draft.minRowCount} onChange={(e) => set('minRowCount', e.target.value)} error={fieldErrors.minRowCount} />
                <Input label={L.deprovisionGraceDays} inputMode="numeric" value={draft.deprovisionGraceDays} onChange={(e) => set('deprovisionGraceDays', e.target.value)} error={fieldErrors.deprovisionGraceDays} />
              </div>
            </fieldset>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                <input type="checkbox" checked={draft.authoritative} onChange={(e) => set('authoritative', e.target.checked)} />
                {L.authoritative}
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} data-testid="feed-enabled" />
                {L.enabled}
              </label>
            </div>

            {error && <p className="text-sm text-red-600" role="alert" data-testid="roster-feed-error">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setFormOpen(false)}>
                {L.cancel}
              </Button>
              <Button type="submit" loading={busy === 'save'} data-testid="roster-feed-save">
                {editingId ? L.save : L.create}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{L.feeds}</CardTitle>
        </CardHeader>
        {loading ? (
          <SkeletonRows rows={3} />
        ) : feeds.length === 0 ? (
          <EmptyState testId="roster-feeds" title={L.none} />
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {feeds.map((f) => (
              <li key={f.id} className="flex flex-wrap items-start justify-between gap-3 py-4" data-testid={`roster-feed-${f.id}`}>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100">{f.name}</span>
                    <Badge variant="default">{f.transport}</Badge>
                    <Badge variant={f.enabled ? 'success' : f.pausedReason ? 'warning' : 'default'}>
                      {f.enabled ? L.on : f.pausedReason ? L.paused : L.off}
                    </Badge>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    {f.cronExpression ? <code className="text-xs">{f.cronExpression}</code> : L.noSchedule}
                    {f.nextRunAt && <> · {fill(L.nextRunAt, { when: when(f.nextRunAt) })}</>}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-300" data-testid={`roster-feed-last-${f.id}`}>
                    {L.lastRun}:{' '}
                    {f.lastRun ? (
                      <>
                        <Badge variant={STATUS_VARIANT[f.lastRun.status] ?? 'default'}>{statusLabel(f.lastRun.status)}</Badge>{' '}
                        <RelativeTime date={f.lastRun.startedAt} />
                      </>
                    ) : (
                      L.never
                    )}
                  </p>
                  {f.pausedReason && <p className="text-sm text-amber-700">{fill(L.pausedReason, { reason: f.pausedReason })}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" loading={busy === `dry-${f.id}`} onClick={() => run(f, true)} data-testid={`roster-dry-run-${f.id}`}>
                    <RefreshCw className="mr-1 h-3.5 w-3.5" /> {L.dryRun}
                  </Button>
                  <Button type="button" size="sm" loading={busy === `run-${f.id}`} onClick={() => run(f, false)} data-testid={`roster-run-${f.id}`}>
                    <Play className="mr-1 h-3.5 w-3.5" /> {L.runNow}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => openHistory(f)} data-testid={`roster-history-${f.id}`}>
                    {L.history}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => openEdit(f)} aria-label={L.edit}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPendingDelete(f)} aria-label={L.delete}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {historyFeed && (
        <Card className="mb-6" data-testid="roster-history">
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <CardTitle>{fill(L.historyOf, { name: historyFeed.name })}</CardTitle>
              <Button type="button" size="sm" variant="ghost" onClick={() => setHistoryFeed(null)} aria-label={L.close}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          {runs.length === 0 ? (
            <EmptyState testId="roster-runs" title={L.noRuns} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-2 pr-3 font-medium">{L.started}</th>
                    <th className="py-2 pr-3 font-medium">{L.status}</th>
                    <th className="py-2 pr-3 font-medium">{L.result}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {runs.map((r) => (
                    <tr key={r.id} data-testid={`roster-run-row-${r.id}`}>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <RelativeTime date={r.startedAt} />
                        {r.dryRun && <span className="ml-1 text-xs text-gray-500">({L.dry})</span>}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={STATUS_VARIANT[r.status] ?? 'default'}>{statusLabel(r.status)}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-gray-600 dark:text-gray-300">{summary(r)}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {r.status === 'ABORTED_SAFETY' && !r.dryRun && r.safetyReason?.startsWith('deactivation_ceiling') && (
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            className="mr-2"
                            loading={busy === `approve-${r.id}`}
                            onClick={() => setPendingApprove({ feed: historyFeed, run: r })}
                            data-testid={`roster-approve-${r.id}`}
                          >
                            {L.approve}
                          </Button>
                        )}
                        <Button type="button" size="sm" variant="outline" onClick={() => openDetail(historyFeed, r)} data-testid={`roster-detail-${r.id}`}>
                          {L.view}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {detail && (
        <Card data-testid="roster-run-detail">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle>{L.runDetail}</CardTitle>
                <CardDescription>
                  {when(detail.run.startedAt)} · {statusLabel(detail.run.status)}
                  {detail.run.dryRun ? ` (${L.dry})` : ''} · {summary(detail.run)}
                </CardDescription>
                {(detail.run.safetyReason || detail.run.error) && (
                  <p className="mt-1 text-sm text-red-700">{detail.run.safetyReason ?? detail.run.error}</p>
                )}
              </div>
              <div className="flex gap-2">
                <a
                  className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200"
                  href={`/api/admin/roster-feeds/${detail.feed.id}/runs/${detail.run.id}?format=csv${rowFilter ? `&status=${rowFilter}` : ''}`}
                  data-testid="roster-run-csv"
                >
                  <Download className="mr-1 h-3.5 w-3.5" /> {L.downloadCsv}
                </a>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDetail(null)} aria-label={L.close}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <div className="mb-3 max-w-xs">
            <Select
              label={L.filter}
              value={rowFilter}
              onChange={(e) => {
                setRowFilter(e.target.value);
                setRowPage(1);
              }}
              options={[
                { value: '', label: L.allActions },
                ...['CREATE', 'UPDATE', 'UNCHANGED', 'SKIP', 'ERROR', 'DEACTIVATE', 'REACTIVATE'].map((s) => ({
                  value: s,
                  label: actionLabel(s),
                })),
              ]}
              data-testid="roster-row-filter"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="roster-rows">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-2 pr-3 font-medium">{L.row}</th>
                  <th className="py-2 pr-3 font-medium">{L.key}</th>
                  <th className="py-2 pr-3 font-medium">{L.action}</th>
                  <th className="py-2 font-medium">{L.message}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {rows.map((r) => (
                  <tr key={`${r.rowNumber}`}>
                    <td className="py-2 pr-3 text-gray-500">{r.rowNumber > 0 ? r.rowNumber : '—'}</td>
                    <td className="py-2 pr-3 break-all">{r.key}</td>
                    <td className="py-2 pr-3">{actionLabel(r.status)}</td>
                    <td className="py-2 text-gray-600 dark:text-gray-300">{r.message ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-between text-sm">
              <Button type="button" size="sm" variant="outline" disabled={rowPage <= 1} onClick={() => setRowPage((p) => p - 1)}>
                {L.previous}
              </Button>
              <span>{fill(L.pageOf, { page: rowPage, pages })}</span>
              <Button type="button" size="sm" variant="outline" disabled={rowPage >= pages} onClick={() => setRowPage((p) => p + 1)}>
                {L.next}
              </Button>
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={L.delete}
        message={pendingDelete ? fill(L.deleteConfirm, { name: pendingDelete.name }) : ''}
        confirmLabel={L.delete}
        cancelLabel={L.cancel}
        variant="danger"
        onConfirm={() => {
          if (pendingDelete) void remove(pendingDelete);
        }}
        onCancel={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        open={pendingApprove !== null}
        title={L.approve}
        message={L.approveConfirm}
        confirmLabel={L.approve}
        cancelLabel={L.cancel}
        variant="danger"
        onConfirm={() => {
          if (pendingApprove) void approve(pendingApprove.feed, pendingApprove.run);
        }}
        onCancel={() => setPendingApprove(null)}
      />
    </div>
  );
}
