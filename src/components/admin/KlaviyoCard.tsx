'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { interpolate } from '@/lib/notificationText';
import { useT } from '@/i18n/client';
import { KLAVIYO_REQUIRED_SCOPES } from '@/lib/klaviyoRule';

// The Klaviyo connector's console on /admin/integrations, MARKETING only
// (docs/integrations/klaviyo.md): paste a read-only key, test it, save it,
// pause/resume, sync now, preview the first profiles (a dry run), disconnect —
// and the status of every other resource it reads (lists, segments and their
// members, metrics, events, campaigns + statistics, flows), one line each.
// Talks to /api/admin/integrations/klaviyo. The key is a password field and is
// never shown again after saving — the server returns its last four only.

interface Connection {
  enabled: boolean;
  keyLast4: string;
  keySource: 'env' | 'db';
  initialSyncDoneAt: string | null;
  lastSyncAt: string | null;
  lastStatus: 'ok' | 'partial' | 'error' | null;
  lastErrorCode: string | null;
  nextAttemptAt: string | null;
  lastCreated: number;
  lastUpdated: number;
  lastUnchanged: number;
  lastSkipped: number;
  lastErrors: number;
  totalCreated: number;
}

type ResourceName = 'lists' | 'segments' | 'members' | 'metrics' | 'events' | 'campaigns' | 'campaign_stats' | 'flows';

interface ResourceStatus {
  resource: ResourceName;
  parts: number;
  lastOkAt: string | null;
  status: 'ok' | 'partial' | 'error' | null;
  errorCode: string | null;
  failing: number;
  rows: number;
  nextAttemptAt: string | null;
}

interface View {
  connected: boolean;
  connection: Connection | null;
  linkedProfiles: number;
  resources: ResourceStatus[];
}

interface PreviewRow {
  row: number;
  status: 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'SKIP' | 'ERROR';
  reason: string | null;
  accountName: string | null;
  contactName: string | null;
  email: string | null;
  source: string | null;
  consent: string | null;
}

const SCOPES = KLAVIYO_REQUIRED_SCOPES.join(', ');
const STATUS_VARIANT = { ok: 'success', partial: 'warning', error: 'danger' } as const;

export function KlaviyoCard() {
  const t = useT();
  const k = t.integrations.klaviyo;
  const [view, setView] = useState<View | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const errorText = useCallback(
    (code: string | null | undefined) => {
      const errors = k.errors as Record<string, string>;
      return interpolate((code && errors[code]) || errors.internal, { scopes: SCOPES });
    },
    [k],
  );

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/integrations/klaviyo');
    if (res.ok) setView(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const call = async (name: string, path: string, init: RequestInit) => {
    setBusy(name);
    setMessage(null);
    try {
      const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json' } });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    const { data } = await call('test', '/api/admin/integrations/klaviyo/test', {
      method: 'POST',
      body: JSON.stringify(key.trim() ? { key } : {}),
    });
    setMessage(data.ok ? { ok: true, text: k.testOk } : { ok: false, text: errorText(data.code) });
  };

  const save = async () => {
    const { res, data } = await call('save', '/api/admin/integrations/klaviyo', { method: 'PUT', body: JSON.stringify({ key }) });
    if (res.ok) {
      setKey('');
      setView(data);
      setMessage({ ok: true, text: k.testOk });
    } else {
      setMessage({ ok: false, text: errorText(data.code) });
    }
  };

  const toggle = async (enabled: boolean) => {
    const { res, data } = await call('toggle', '/api/admin/integrations/klaviyo', { method: 'PATCH', body: JSON.stringify({ enabled }) });
    if (res.ok) setView(data);
  };

  const syncNow = async (scope: 'profiles' | 'all' = 'profiles') => {
    const { res, data } = await call(scope === 'all' ? 'syncAll' : 'sync', '/api/admin/integrations/klaviyo/sync', {
      method: 'POST',
      body: JSON.stringify({ scope }),
    });
    if (res.status === 409) {
      setMessage({ ok: false, text: data.code === 'busy' ? k.busy : k.disabled });
      return;
    }
    if (res.ok) {
      setView({ connected: data.connected, connection: data.connection, linkedProfiles: data.linkedProfiles, resources: data.resources ?? [] });
      if (data.outcome === 'error') setMessage({ ok: false, text: errorText(data.code) });
    }
  };

  const runPreview = async () => {
    const { data } = await call('preview', '/api/admin/integrations/klaviyo/preview', { method: 'POST' });
    if (data.ok) setPreview(data.rows);
    else setMessage({ ok: false, text: errorText(data.code) });
  };

  const disconnect = async () => {
    const { res, data } = await call('disconnect', '/api/admin/integrations/klaviyo', { method: 'DELETE' });
    setConfirmDisconnect(false);
    if (res.ok) {
      setView(data);
      setPreview(null);
    }
  };

  const c = view?.connection ?? null;

  return (
    <Card data-testid="klaviyo-card">
      <CardHeader>
        <CardTitle>{k.title}</CardTitle>
      </CardHeader>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{k.intro}</p>

      {c && (
        <div className="mb-4 space-y-1 text-sm" data-testid="klaviyo-status">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-gray-700 dark:text-gray-300" data-testid="klaviyo-key-last4">
              {interpolate(k.keySaved, { last4: c.keyLast4 })}
            </span>
            {c.keySource === 'env' && (
              <Badge variant="info" data-testid="klaviyo-key-source-env">
                {k.keySourceEnv}
              </Badge>
            )}
            <Badge variant={c.enabled ? 'success' : 'default'}>{c.enabled ? k.enabled : k.disabled}</Badge>
            {c.lastStatus && (
              <Badge variant={STATUS_VARIANT[c.lastStatus]} data-testid="klaviyo-last-status">
                {k.status[c.lastStatus]}
              </Badge>
            )}
          </div>
          <p className="text-gray-500 dark:text-gray-400">
            {k.lastSync}: {c.lastSyncAt ? <RelativeTime date={c.lastSyncAt} /> : k.never}
          </p>
          {c.lastSyncAt && (
            <p className="text-gray-500 dark:text-gray-400" data-testid="klaviyo-counts">
              {interpolate(k.counts, {
                created: String(c.lastCreated),
                updated: String(c.lastUpdated),
                unchanged: String(c.lastUnchanged),
                skipped: String(c.lastSkipped),
                errors: String(c.lastErrors),
              })}
            </p>
          )}
          <p className="text-gray-500 dark:text-gray-400" data-testid="klaviyo-linked">
            {interpolate(k.linked, { count: String(view?.linkedProfiles ?? 0), total: String(c.totalCreated) })}
          </p>
          <p className="text-gray-500 dark:text-gray-400">{c.initialSyncDoneAt ? k.firstImportDone : k.firstImport}</p>
          {c.lastStatus === 'error' && (
            <p className="text-red-600 dark:text-red-400" data-testid="klaviyo-error">
              {errorText(c.lastErrorCode)}
              {c.nextAttemptAt && <> · {fillTemplate(`${k.nextAttempt}: {when}`, { when: <RelativeTime date={c.nextAttemptAt} /> })}</>}
            </p>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label htmlFor="klaviyo-key" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {k.keyLabel}
          </label>
          <Input
            id="klaviyo-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="pk_…"
            data-testid="klaviyo-key-input"
          />
          <p className="mt-1 text-xs text-gray-500">{interpolate(k.keyHint, { scopes: SCOPES })}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={test} loading={busy === 'test'} disabled={!key.trim() && !c} data-testid="klaviyo-test">
            {k.test}
          </Button>
          <Button type="button" onClick={save} loading={busy === 'save'} disabled={!key.trim()} data-testid="klaviyo-save">
            {c ? k.replace : k.save}
          </Button>
          {c && (
            <>
              <Button type="button" variant="secondary" onClick={() => syncNow()} loading={busy === 'sync'} disabled={!c.enabled} data-testid="klaviyo-sync-now">
                {busy === 'sync' ? k.syncing : k.syncNow}
              </Button>
              <Button type="button" variant="outline" onClick={() => syncNow('all')} loading={busy === 'syncAll'} disabled={!c.enabled} data-testid="klaviyo-sync-all">
                {busy === 'syncAll' ? k.syncing : k.syncAll}
              </Button>
              <Button type="button" variant="outline" onClick={runPreview} loading={busy === 'preview'} data-testid="klaviyo-preview">
                {k.preview}
              </Button>
              <Button type="button" variant="ghost" onClick={() => toggle(!c.enabled)} loading={busy === 'toggle'} data-testid="klaviyo-toggle">
                {c.enabled ? k.disable : k.enable}
              </Button>
              <Button type="button" variant="danger" onClick={() => setConfirmDisconnect(true)} data-testid="klaviyo-disconnect">
                {k.disconnect}
              </Button>
            </>
          )}
        </div>
        {message && (
          <p role="status" className={`text-sm ${message.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`} data-testid="klaviyo-message">
            {message.text}
          </p>
        )}
      </div>

      {c && view && view.resources.length > 0 && (
        <div className="mt-6" data-testid="klaviyo-resources">
          <h3 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{k.resources.title}</h3>
          <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{k.resources.hint}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-gray-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">{k.resources.columns.resource}</th>
                  <th className="py-1 pr-3 font-medium">{k.resources.columns.status}</th>
                  <th className="py-1 pr-3 font-medium">{k.resources.columns.rows}</th>
                  <th className="py-1 pr-3 font-medium">{k.resources.columns.lastOk}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {view.resources.map((r) => (
                  <tr key={r.resource} data-testid={`klaviyo-resource-${r.resource}`}>
                    <td className="py-1 pr-3">{k.resources.names[r.resource]}</td>
                    <td className="py-1 pr-3">
                      {r.status ? (
                        <Badge variant={STATUS_VARIANT[r.status]}>{k.status[r.status]}</Badge>
                      ) : (
                        <span className="text-gray-500">{k.resources.pending}</span>
                      )}
                      {r.status === 'error' || r.failing > 0 ? (
                        <span className="ml-2 text-red-600 dark:text-red-400" data-testid={`klaviyo-resource-error-${r.resource}`}>
                          {r.parts > 1 ? `${interpolate(k.resources.failing, { count: String(r.failing) })} · ` : ''}
                          {errorText(r.errorCode)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{r.rows}</td>
                    <td className="py-1 pr-3">{r.lastOkAt ? <RelativeTime date={r.lastOkAt} /> : k.never}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview && (
        <div className="mt-6" data-testid="klaviyo-preview-table">
          <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">{k.previewTitle}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-gray-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">{k.previewColumns.status}</th>
                  <th className="py-1 pr-3 font-medium">{k.previewColumns.account}</th>
                  <th className="py-1 pr-3 font-medium">{k.previewColumns.contact}</th>
                  <th className="py-1 pr-3 font-medium">{k.previewColumns.email}</th>
                  <th className="py-1 pr-3 font-medium">{k.previewColumns.source}</th>
                  <th className="py-1 pr-3 font-medium">{k.previewColumns.consent}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {preview.map((r) => (
                  <tr key={r.row} title={r.reason ?? undefined}>
                    <td className="py-1 pr-3">{k.statuses[r.status]}</td>
                    <td className="py-1 pr-3">{r.accountName}</td>
                    <td className="py-1 pr-3">{r.contactName}</td>
                    <td className="py-1 pr-3 break-all">{r.email}</td>
                    <td className="py-1 pr-3 break-all">{r.source}</td>
                    <td className="py-1 pr-3">{r.consent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        title={k.disconnect}
        message={k.disconnectConfirm}
        confirmLabel={k.disconnect}
        cancelLabel={t.common.cancel}
        variant="danger"
        loading={busy === 'disconnect'}
        onConfirm={disconnect}
        onCancel={() => setConfirmDisconnect(false)}
      />
    </Card>
  );
}
