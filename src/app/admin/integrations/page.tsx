'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDate, relativeTime } from '@/lib/relativeTime';
import { API_SCOPES, DEFAULT_API_SCOPES, maxApiKeyExpiry, type ApiKeyStatus } from '@/lib/apiScopes';

interface Hook { id: string; url: string; events: string[]; active: boolean }
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
};

export default function IntegrationsPage() {
  const t = useT();
  const locale = useLocale();
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState('');
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>([...DEFAULT_API_SCOPES]);
  const [keyExpiry, setKeyExpiry] = useState('');
  const [newKey, setNewKey] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editEvents, setEditEvents] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [health, setHealth] = useState<ConnectorHealth[]>([]);

  const load = useCallback(async () => {
    const [w, k, g, h] = await Promise.all([
      fetch('/api/admin/webhooks'),
      fetch('/api/admin/api-keys'),
      fetch('/api/admin/integrations/google/status'),
      fetch('/api/admin/integrations/health'),
    ]);
    if (w.ok) { const d = await w.json(); setHooks(d.webhooks ?? []); setEventTypes(d.eventTypes ?? []); }
    if (k.ok) setKeys((await k.json()).keys ?? []);
    if (g.ok) setGoogle(await g.json());
    if (h.ok) setHealth((await h.json()).connectors ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const addHook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url || events.length === 0) return;
    const res = await fetch('/api/admin/webhooks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, events }),
    });
    if (res.ok) { const d = await res.json(); setSecret(d.secret); setUrl(''); setEvents([]); await load(); }
  };
  const delHook = async (id: string) => { await fetch(`/api/admin/webhooks?id=${id}`, { method: 'DELETE' }); await load(); };

  const patchHook = async (id: string, body: Record<string, unknown>) => {
    await fetch(`/api/admin/webhooks?id=${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
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
      }),
    });
    if (res.ok) {
      const d = await res.json();
      setNewKey(d.key);
      setKeyName('');
      setKeyExpiry('');
      setKeyScopes([...DEFAULT_API_SCOPES]);
      await load();
    }
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

      <Card className="mb-6" data-testid="integration-health">
        <CardHeader><CardTitle>{t.integrations.health}</CardTitle></CardHeader>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{t.integrations.healthDesc}</p>
        <div className="divide-y divide-gray-50 dark:divide-gray-800">
          {health.map((c) => (
            <div key={c.connector} data-testid={`health-row-${c.connector}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <p className="text-sm text-gray-900 dark:text-gray-100">{labels[CONNECTOR_LABEL[c.connector]] ?? c.connector}</p>
                <p className="text-xs text-gray-400">
                  {t.integrations.lastOk}: {c.lastOkAt ? relativeTime(c.lastOkAt, locale) : t.integrations.never}
                  {c.lastErrorAt ? ` · ${t.integrations.lastError}: ${relativeTime(c.lastErrorAt, locale)}` : ''}
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
            <div className="flex flex-wrap gap-3">
              {eventTypes.map((ev) => (
                <label key={ev} className="flex items-center gap-1.5 text-xs text-gray-700">
                  <input type="checkbox" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} /> {ev}
                </label>
              ))}
            </div>
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
                      {testResult[h.id] && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{testResult[h.id]}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => startEdit(h)}>{t.integrations.editWebhook}</Button>
                      <Button size="sm" variant="ghost" data-testid={`webhook-pause-${h.id}`} onClick={() => patchHook(h.id, { active: !h.active })}>
                        {h.active ? t.integrations.pause : t.integrations.resume}
                      </Button>
                      <Button size="sm" variant="ghost" data-testid={`webhook-test-${h.id}`} onClick={() => sendTest(h.id)}>{t.integrations.sendTest}</Button>
                      <Button size="sm" variant="ghost" onClick={() => rotate(h.id)}>{t.integrations.rotateSecret}</Button>
                      <button onClick={() => delHook(h.id)} aria-label="delete" className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                  {editing === h.id && (
                    <div className="mt-2 space-y-2">
                      <Input data-testid="webhook-edit-url" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} />
                      <div className="flex flex-wrap gap-3">
                        {eventTypes.map((ev) => (
                          <label key={ev} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                            <input type="checkbox" checked={editEvents.includes(ev)} onChange={() => toggleEditEvent(ev)} /> {ev}
                          </label>
                        ))}
                      </div>
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
                    <p className="text-xs text-gray-400">{k.lastUsedAt ? `${t.integrations.lastUsed}: ${formatDate(k.lastUsedAt, locale)}` : t.integrations.neverUsed}</p>
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
      </div>
    </div>
  );
}
