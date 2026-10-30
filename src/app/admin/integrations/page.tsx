'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { groupWebhookEvents, type WebhookEventFamily } from '@/lib/webhookEventFamilies';
import { formatDate } from '@/lib/relativeTime';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { API_SCOPES, DEFAULT_API_SCOPES, maxApiKeyExpiry, type ApiKeyStatus } from '@/lib/apiScopes';
import { AuditDrainsCard } from '@/components/admin/AuditDrainsCard';
import { KlaviyoCard } from '@/components/admin/KlaviyoCard';
import { ChatAppsCard } from '@/components/admin/ChatAppsCard';
import { WebhookDeliveries } from '@/components/admin/WebhookDeliveries';
import { useVertical } from '@/lib/verticalClient';

interface Hook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  // Auto-disabled by the delivery job after a failure streak (#1695).
  disabledAt?: string | null;
  disabledReason?: string | null;
}
interface Key {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  createdBy: { name: string | null; email: string } | null;
  status: ApiKeyStatus;
  quotaPeriod: 'day' | 'month' | null;
  quotaLimit: number | null;
  usage: { period: 'day' | 'month'; requests: number; resetAt: string } | null;
}

// The <input type="date"> bounds: no earlier than today, no later than the
// server's own 12-month ceiling.
function maxExpiryInputValue(): string {
  return maxApiKeyExpiry().toISOString().slice(0, 10);
}
function todayInputValue(): string {
  return new Date().toISOString().slice(0, 10);
}
interface GoogleStatus { configured: boolean; connected: boolean }
// GET /api/admin/integrations/jaas-usage — four numbers and two booleans, no
// identities (#2011). `metered` is whether the webhook feed that produces the
// count is wired at all: without it `active` is a truthful zero rather than a
// measurement, and the card has to say which.
interface JaasUsage {
  configured: boolean;
  metered: boolean;
  period: string;
  active: number;
  allowance: number;
  remaining: number;
}
interface ConnectorHealth {
  connector: string;
  state: string;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  detail: Record<string, unknown>;
}

// The state vocabulary of /api/admin/integrations/health (src/lib/integrationHealth.ts).
const STATE_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  ok: 'success', degraded: 'warning', failing: 'danger', not_configured: 'default',
};
const STATE_LABEL: Record<string, string> = {
  ok: 'stateOk', degraded: 'stateDegraded', failing: 'stateFailing', not_configured: 'stateNotConfigured',
};
const CONNECTOR_LABEL: Record<string, string> = {
  email: 'connectorEmail',
  webhooks: 'connectorWebhooks',
  google_calendar: 'connectorGoogle',
  sso: 'connectorSso',
  inbound_jaas: 'connectorInboundJaas',
  inbound_email: 'connectorInboundEmail',
  audit_drain: 'connectorAuditDrain',
};

export default function IntegrationsPage() {
  const t = useT();
  const locale = useLocale();
  // The Klaviyo connector feeds the marketing funnel (docs/integrations/klaviyo.md).
  const isMarketing = useVertical() === 'MARKETING';
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState('');
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>([...DEFAULT_API_SCOPES]);
  const [keyExpiry, setKeyExpiry] = useState('');
  const [keyQuotaPeriod, setKeyQuotaPeriod] = useState<'' | 'day' | 'month'>('');
  const [keyQuotaLimit, setKeyQuotaLimit] = useState('');
  const [quotaEdit, setQuotaEdit] = useState<{ id: string | null; period: '' | 'day' | 'month'; limit: string }>({ id: null, period: '', limit: '' });
  const [newKey, setNewKey] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editEvents, setEditEvents] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [showDeliveries, setShowDeliveries] = useState<string | null>(null);
  // The plan lacks INTEGRATIONS_API (#1744): set when a write answers 403
  // feature_locked, so the refusal is explained instead of swallowed.
  const [apiLocked, setApiLocked] = useState(false);
  const noteLocked = async (res: Response) => {
    if (res.status !== 403) return;
    const d = await res.clone().json().catch(() => ({}));
    if (d.code === 'feature_locked') setApiLocked(true);
  };

  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [health, setHealth] = useState<ConnectorHealth[]>([]);
  const [jaas, setJaas] = useState<JaasUsage | null>(null);

  const load = useCallback(async () => {
    const [w, k, g, h, v] = await Promise.all([
      fetch('/api/admin/webhooks'),
      fetch('/api/admin/api-keys'),
      fetch('/api/admin/integrations/google/status'),
      fetch('/api/admin/integrations/health'),
      fetch('/api/admin/integrations/jaas-usage'),
    ]);
    if (w.ok) { const d = await w.json(); setHooks(d.webhooks ?? []); setEventTypes(d.eventTypes ?? []); }
    if (k.ok) setKeys((await k.json()).keys ?? []);
    if (g.ok) setGoogle(await g.json());
    if (h.ok) setHealth((await h.json()).connectors ?? []);
    if (v.ok) setJaas(await v.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  const addHook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url || events.length === 0) return;
    const res = await fetch('/api/admin/webhooks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, events }),
    });
    await noteLocked(res);
    if (res.ok) { const d = await res.json(); setSecret(d.secret); setUrl(''); setEvents([]); await load(); }
  };
  const delHook = async (id: string) => { await fetch(`/api/admin/webhooks?id=${id}`, { method: 'DELETE' }); await load(); };

  const patchHook = async (id: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/admin/webhooks?id=${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await noteLocked(res);
    await load();
  };
  const startEdit = (h: Hook) => { setEditing(h.id); setEditUrl(h.url); setEditEvents(h.events); };
  const saveEdit = async (id: string) => { await patchHook(id, { url: editUrl, events: editEvents }); setEditing(null); };
  const rotate = async (id: string) => {
    if (!confirm(t.integrations.rotateSecretConfirm)) return;
    const res = await fetch(`/api/admin/webhooks/rotate-secret?id=${id}`, { method: 'POST' });
    if (res.ok) setSecret((await res.json()).secret);
  };
  const sendTest = async (id: string) => {
    const res = await fetch(`/api/admin/webhooks/test?id=${id}`, { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    const message = res.status === 429
      ? t.integrations.testRateLimited
      : d.ok
        ? t.integrations.testOk.replace('{status}', String(d.status)).replace('{ms}', String(d.ms))
        : t.integrations.testFailed;
    setTestResult((p) => ({ ...p, [id]: message }));
  };

  const addKey = async (e: React.FormEvent) => {
    e.preventDefault();
    // At least one scope, always — the server enforces the same rule.
    if (!keyName || keyScopes.length === 0) return;
    const res = await fetch('/api/admin/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: keyName,
        scopes: keyScopes,
        // The picker yields a date; the API wants an instant — end of that day.
        expiresAt: keyExpiry ? new Date(`${keyExpiry}T23:59:59.000Z`).toISOString() : null,
        ...(keyQuotaPeriod && keyQuotaLimit ? { quotaPeriod: keyQuotaPeriod, quotaLimit: Number(keyQuotaLimit) } : {}),
      }),
    });
    await noteLocked(res);
    if (res.ok) {
      const d = await res.json();
      setNewKey(d.key);
      setKeyName('');
      setKeyExpiry('');
      setKeyQuotaPeriod('');
      setKeyQuotaLimit('');
      setKeyScopes([...DEFAULT_API_SCOPES]);
      await load();
    }
  };
  // The period allowance (#2010): set or cleared in place, scopes stay as minted.
  const saveQuota = async (id: string) => {
    const body = quotaEdit.period && quotaEdit.limit ? { quotaPeriod: quotaEdit.period, quotaLimit: Number(quotaEdit.limit) } : { quotaPeriod: null, quotaLimit: null };
    const res = await fetch(`/api/admin/api-keys?id=${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) { setQuotaEdit({ id: null, period: '', limit: '' }); await load(); }
  };
  const usageLine = (k: Key) => {
    if (!k.usage) return null;
    const period = k.usage.period === 'day' ? t.integrations.keyPeriodDay : t.integrations.keyPeriodMonth;
    const n = k.usage.requests.toLocaleString(locale);
    return k.quotaLimit !== null
      ? t.integrations.keyUsageOf.replace('{n}', n).replace('{limit}', k.quotaLimit.toLocaleString(locale)).replace('{period}', period)
      : t.integrations.keyUsage.replace('{n}', n).replace('{period}', period);
  };
  // Soft revoke: the row stays so the activity log keeps a target to point at.
  const delKey = async (id: string) => { await fetch(`/api/admin/api-keys?id=${id}`, { method: 'DELETE' }); await load(); };
  const toggleScope = (sc: string) => setKeyScopes((p) => (p.includes(sc) ? p.filter((x) => x !== sc) : [...p, sc]));
  const statusLabel = (st: ApiKeyStatus) =>
    st === 'revoked'
      ? t.integrations.keyStatusRevoked
      : st === 'expired'
        ? t.integrations.keyStatusExpired
        : t.integrations.keyStatusActive;
  const statusClass = (st: ApiKeyStatus) =>
    st === 'revoked'
      ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200'
      : st === 'expired'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100'
        : 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200';

  const labels = t.integrations as unknown as Record<string, string>;

  const toggleEvent = (ev: string) => setEvents((p) => (p.includes(ev) ? p.filter((x) => x !== ev) : [...p, ev]));
  const toggleEditEvent = (ev: string) => setEditEvents((p) => (p.includes(ev) ? p.filter((x) => x !== ev) : [...p, ev]));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.integrations.title}</h1>
        <p className="text-gray-500 mt-1">{t.integrations.subtitle}</p>
      </div>

      {apiLocked && (
        <div role="alert" data-testid="integrations-locked" className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          {t.integrations.apiLocked}
        </div>
      )}

      <Card className="mb-6" data-testid="integration-health">
        <CardHeader><CardTitle>{t.integrations.health}</CardTitle></CardHeader>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{t.integrations.healthDesc}</p>
        <div className="divide-y divide-gray-50 dark:divide-gray-800">
          {health.map((c) => (
            <div key={c.connector} data-testid={`health-row-${c.connector}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <p className="text-sm text-gray-900 dark:text-gray-100">{labels[CONNECTOR_LABEL[c.connector]] ?? c.connector}</p>
                <p className="text-xs text-gray-400">
                  {t.integrations.lastOk}: {c.lastOkAt ? <RelativeTime date={c.lastOkAt} /> : t.integrations.never}
                  {c.lastErrorAt && <> · {t.integrations.lastError}: <RelativeTime date={c.lastErrorAt} /></>}
                </p>
                {c.lastError && <p className="text-xs text-red-600 dark:text-red-400 break-words">{c.lastError}</p>}
                {c.detail?.deliveryHealthPending ? <p className="text-xs text-gray-400">{t.integrations.deliveryPending}</p> : null}
              </div>
              <Badge variant={STATE_VARIANT[c.state] ?? 'default'} data-testid={`health-state-${c.connector}`}>
                {labels[STATE_LABEL[c.state]] ?? c.state}
              </Badge>
            </div>
          ))}
        </div>
      </Card>

      {isMarketing && (
        <div className="mb-6">
          <KlaviyoCard />
        </div>
      )}

      <div className="mb-6">
        <ChatAppsCard />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>{t.integrations.webhooks}</CardTitle></CardHeader>
          {secret && (
            <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 break-all">
              {t.integrations.secretOnce}: <code>{secret}</code>
            </div>
          )}
          <form onSubmit={addHook} className="space-y-2 mb-4">
            <Input placeholder="https://example.com/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
            <EventPicker eventTypes={eventTypes} selected={events} onToggle={toggleEvent} />
            <Button type="submit" size="sm" disabled={!url || events.length === 0}>{t.integrations.addWebhook}</Button>
          </form>
          {hooks.length === 0 ? <p className="text-sm text-gray-400">{t.integrations.noWebhooks}</p> : (
            <div className="divide-y divide-gray-50">
              {hooks.map((h) => (
                <div key={h.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-gray-900 dark:text-gray-100">
                        {h.url}
                        {!h.active && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                            {t.integrations.paused}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-gray-400">{h.events.join(', ')}</p>
                      {h.disabledAt && (
                        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-red-700 dark:text-red-300" data-testid={`webhook-disabled-${h.id}`}>
                          <span>
                            {t.integrations.autoDisabled} — <RelativeTime date={h.disabledAt} />: {h.disabledReason}
                          </span>
                          <button type="button" className="text-blue-600 hover:underline" data-testid={`webhook-reenable-${h.id}`} onClick={() => patchHook(h.id, { active: true })}>
                            {t.integrations.reenable}
                          </button>
                        </p>
                      )}
                      {testResult[h.id] && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{testResult[h.id]}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => startEdit(h)}>{t.integrations.editWebhook}</Button>
                      <Button size="sm" variant="ghost" data-testid={`webhook-pause-${h.id}`} onClick={() => patchHook(h.id, { active: !h.active })}>
                        {h.active ? t.integrations.pause : t.integrations.resume}
                      </Button>
                      <Button size="sm" variant="ghost" data-testid={`webhook-test-${h.id}`} onClick={() => sendTest(h.id)}>{t.integrations.sendTest}</Button>
                      <Button size="sm" variant="ghost" onClick={() => rotate(h.id)}>{t.integrations.rotateSecret}</Button>
                      <Button size="sm" variant="ghost" data-testid={`webhook-deliveries-toggle-${h.id}`} onClick={() => setShowDeliveries((cur) => (cur === h.id ? null : h.id))}>
                        {showDeliveries === h.id ? t.integrations.deliveriesHide : t.integrations.deliveries}
                      </Button>
                      <button onClick={() => delHook(h.id)} aria-label={t.common.delete} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                  {showDeliveries === h.id && <WebhookDeliveries hookId={h.id} />}
                  {editing === h.id && (
                    <div className="mt-2 space-y-2">
                      <Input data-testid="webhook-edit-url" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} />
                      <EventPicker eventTypes={eventTypes} selected={editEvents} onToggle={toggleEditEvent} />
                      <div className="flex gap-2">
                        <Button size="sm" disabled={!editUrl || editEvents.length === 0} onClick={() => saveEdit(h.id)}>{t.integrations.save}</Button>
                        <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>{t.integrations.cancel}</Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader><CardTitle>{t.integrations.apiKeys}</CardTitle></CardHeader>
          {newKey && (
            <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 break-all">
              {t.integrations.keyOnce}: <code>{newKey}</code>
            </div>
          )}
          <form onSubmit={addKey} className="space-y-2 mb-4" data-testid="api-key-form">
            <Input placeholder={t.integrations.keyName} value={keyName} onChange={(e) => setKeyName(e.target.value)} data-testid="api-key-name" />
            <div>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{t.integrations.keyScopes}</p>
              <div className="flex flex-wrap gap-3">
                {API_SCOPES.map((sc) => (
                  <label key={sc} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      data-testid={`api-key-scope-${sc}`}
                      checked={keyScopes.includes(sc)}
                      onChange={() => toggleScope(sc)}
                    />
                    <code>{sc}</code>
                  </label>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">{t.integrations.keyScopesHint}</p>
            </div>
            <div>
              <label htmlFor="api-key-expiry" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t.integrations.keyExpiry}
              </label>
              <Input
                id="api-key-expiry"
                type="date"
                data-testid="api-key-expiry"
                value={keyExpiry}
                min={todayInputValue()}
                max={maxExpiryInputValue()}
                onChange={(e) => setKeyExpiry(e.target.value)}
              />
              <p className="text-xs text-gray-400 mt-1">{t.integrations.keyExpiryHint}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{t.integrations.keyQuota}</p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label={t.integrations.keyQuota}
                  value={keyQuotaPeriod}
                  onChange={(e) => setKeyQuotaPeriod(e.target.value as '' | 'day' | 'month')}
                  data-testid="api-key-quota-period"
                  className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800"
                >
                  <option value="">{t.integrations.keyQuotaNone}</option>
                  <option value="day">{t.integrations.keyQuotaDay}</option>
                  <option value="month">{t.integrations.keyQuotaMonth}</option>
                </select>
                {keyQuotaPeriod && (
                  <div className="w-32">
                    <Input type="number" min={1} step={1} aria-label={t.integrations.keyQuotaLimit} placeholder={t.integrations.keyQuotaLimit} value={keyQuotaLimit} onChange={(e) => setKeyQuotaLimit(e.target.value)} data-testid="api-key-quota-limit" />
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-400 mt-1">{t.integrations.keyQuotaHint}</p>
            </div>
            {!keyExpiry && (
              <p
                data-testid="api-key-no-expiry-warning"
                className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{t.integrations.keyNoExpiryWarning}</span>
              </p>
            )}
            <Button type="submit" size="sm" disabled={!keyName || keyScopes.length === 0}>{t.integrations.generate}</Button>
          </form>
          {keys.length === 0 ? <p className="text-sm text-gray-400">{t.integrations.noKeys}</p> : (
            <div className="divide-y divide-gray-50" data-testid="api-key-list">
              {keys.map((k) => (
                <div key={k.id} data-testid={`api-key-row-${k.id}`} className="flex items-start justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-gray-900 dark:text-gray-100">
                      <span className="truncate">{k.name}</span>
                      <span
                        data-testid={`api-key-status-${k.id}`}
                        className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass(k.status)}`}
                      >
                        {statusLabel(k.status)}
                      </span>
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400" data-testid={`api-key-owner-${k.id}`}>
                      {t.integrations.keyOwner}: {k.createdBy?.name || k.createdBy?.email || t.integrations.keyOwnerUnknown}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400" data-testid={`api-key-expiry-${k.id}`}>
                      {k.expiresAt ? `${t.integrations.keyExpires}: ${formatDate(k.expiresAt, locale)}` : t.integrations.keyNoExpiry}
                    </p>
                    {!k.expiresAt && !k.revokedAt && (
                      <p
                        className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"
                        data-testid={`api-key-no-expiry-${k.id}`}
                      >
                        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {t.integrations.keyNoExpiryWarning}
                      </p>
                    )}
                    <p className="text-xs text-gray-400"><code>{k.scopes.join(', ')}</code></p>
                    <p className="text-xs text-gray-400">{k.lastUsedAt ? <>{t.integrations.lastUsed}: <RelativeTime date={k.lastUsedAt} /></> : t.integrations.neverUsed}</p>
                    {k.usage && <p className="text-xs text-gray-500 dark:text-gray-400" data-testid={`api-key-usage-${k.id}`}>{usageLine(k)}</p>}
                    {!k.revokedAt && (quotaEdit.id === k.id ? (
                      <div className="mt-1 flex flex-wrap items-center gap-2" data-testid={`api-key-quota-edit-${k.id}`}>
                        <select
                          aria-label={t.integrations.keyQuota}
                          value={quotaEdit.period}
                          onChange={(e) => setQuotaEdit((q) => ({ ...q, period: e.target.value as '' | 'day' | 'month' }))}
                          className="rounded border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
                        >
                          <option value="">{t.integrations.keyQuotaNone}</option>
                          <option value="day">{t.integrations.keyQuotaDay}</option>
                          <option value="month">{t.integrations.keyQuotaMonth}</option>
                        </select>
                        {quotaEdit.period && (
                          <input type="number" min={1} step={1} aria-label={t.integrations.keyQuotaLimit} value={quotaEdit.limit} onChange={(e) => setQuotaEdit((q) => ({ ...q, limit: e.target.value }))} className="w-24 rounded border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800" />
                        )}
                        <button type="button" onClick={() => void saveQuota(k.id)} className="text-xs text-blue-600 hover:underline">{t.integrations.keyQuotaSave}</button>
                        <button type="button" onClick={() => setQuotaEdit({ id: null, period: '', limit: '' })} className="text-xs text-gray-500 hover:underline">{t.integrations.keyQuotaCancel}</button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setQuotaEdit({ id: k.id, period: k.quotaPeriod ?? '', limit: k.quotaLimit ? String(k.quotaLimit) : '' })} className="mt-0.5 text-xs text-blue-600 hover:underline" data-testid={`api-key-quota-edit-button-${k.id}`}>
                        {t.integrations.keyQuotaEdit}
                      </button>
                    ))}
                  </div>
                  {!k.revokedAt && (
                    <button
                      onClick={() => delKey(k.id)}
                      aria-label={t.integrations.keyRevoke}
                      title={t.integrations.keyRevoke}
                      data-testid={`api-key-revoke-${k.id}`}
                      className="p-1.5 text-gray-400 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-400 mt-2">{t.integrations.keyRevokedHint}</p>
          <p className="text-xs text-gray-400 mt-3">{t.integrations.apiHint} <code>GET /api/v1/candidates</code></p>
          <Link href="/admin/api-docs" className="inline-block text-sm text-blue-600 hover:underline mt-2">{t.integrations.apiDocsLink} →</Link>
          <Link href="/admin/api-explorer" className="block text-sm text-blue-600 hover:underline mt-1">{t.integrations.apiExplorerLink} →</Link>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t.integrations.googleCalendar}</CardTitle></CardHeader>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{t.integrations.googleCalendarDesc}</p>
          {google && (
            <div className="flex items-center gap-2 mb-3">
              <span
                data-testid="google-status"
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  google.configured
                    ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
                }`}
              >
                {google.configured ? t.integrations.googleConfigured : t.integrations.googleNotConfigured}
              </span>
            </div>
          )}
          {google && !google.configured && (
            <p className="text-xs text-gray-400">{t.integrations.googleSetupHint}</p>
          )}
          {google && google.configured && !google.connected && (
            <p className="text-xs text-gray-400">{t.integrations.googleReadyHint}</p>
          )}
        </Card>

        {/* The video allowance, counted from our own data (#2011). Reported so
            a human can decide about a paid tier from evidence; it charges
            nobody and gates nothing. */}
        <Card data-testid="jaas-usage">
          <CardHeader><CardTitle>{t.integrations.videoAllowance}</CardTitle></CardHeader>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{t.integrations.videoAllowanceDesc}</p>
          {jaas && (
            <>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100" data-testid="jaas-usage-count">
                {t.integrations.videoAllowanceCount
                  .replace('{used}', String(jaas.active))
                  .replace('{limit}', String(jaas.allowance))}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {t.integrations.videoAllowancePeriod.replace('{period}', jaas.period)}
              </p>
              <div
                className="mt-3 h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden"
                role="img"
                aria-label={t.integrations.videoAllowanceCount
                  .replace('{used}', String(jaas.active))
                  .replace('{limit}', String(jaas.allowance))}
              >
                <div
                  className={jaas.remaining > 0 ? 'h-full bg-blue-600' : 'h-full bg-amber-500'}
                  style={{ width: `${jaas.allowance > 0 ? Math.min(100, (jaas.active / jaas.allowance) * 100) : 100}%` }}
                />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-3" data-testid="jaas-usage-state">
                {!jaas.configured
                  ? t.integrations.videoAllowanceUnconfigured
                  : !jaas.metered
                    ? t.integrations.videoAllowanceUnmetered
                    : jaas.remaining > 0
                      ? t.integrations.videoAllowanceRemaining.replace('{n}', String(jaas.remaining))
                      : t.integrations.videoAllowanceSpent}
              </p>
              <p className="text-xs text-gray-400 mt-2">{t.integrations.videoAllowancePrivacy}</p>
            </>
          )}
        </Card>

        {/* The audit stream (#2012): the tenant's AuditLog rows, signed and
            POSTed to a SIEM. Own component — own fetch, own one-time secret
            banner — so this page only mounts it. */}
        <AuditDrainsCard onLocked={() => setApiLocked(true)} />
      </div>
    </div>
  );
}

// The subscribable events grouped by family (#1998, src/lib/webhookEventFamilies.ts),
// so thirty-odd names read as a few sections instead of one wall of checkboxes.
function EventPicker({ eventTypes, selected, onToggle }: { eventTypes: string[]; selected: string[]; onToggle: (ev: string) => void }) {
  const t = useT();
  const label: Record<WebhookEventFamily, string> = {
    pipeline: t.integrations.familyPipeline,
    mentorship: t.integrations.familyMentorship,
    activity: t.integrations.familyActivity,
    meetings: t.integrations.familyMeetings,
    interviews: t.integrations.familyInterviews,
    hiring: t.integrations.familyHiring,
    people: t.integrations.familyPeople,
    other: t.integrations.familyOther,
  };
  return (
    <div className="space-y-2" data-testid="webhook-event-picker">
      {groupWebhookEvents(eventTypes).map((g) => (
        <fieldset key={g.family} data-testid={`webhook-family-${g.family}`}>
          <legend className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label[g.family]}</legend>
          <div className="flex flex-wrap gap-3">
            {g.events.map((ev) => (
              <label key={ev} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={selected.includes(ev)} onChange={() => onToggle(ev)} /> {ev}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
