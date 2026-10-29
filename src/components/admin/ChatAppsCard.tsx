'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useT } from '@/i18n/client';
import { interpolate } from '@/lib/notificationText';
import type { ChatDeliveryView, ChatStatusView, ChatWorkspaceView } from '@/lib/chat/workspaces';

// The chat apps' install console on /admin/integrations (#1958): what is
// installed, by whom, with which scopes; the per-workspace kill switch; and the
// uninstall that revokes the token on the platform and deletes it here. Reads
// GET /api/admin/integrations/chat/status (never a token); writes PATCH/DELETE
// /api/admin/integrations/chat/[id], which decide on the server again.

const PLATFORM_LABEL = { SLACK: 'Slack', TEAMS: 'Microsoft Teams' } as const;
const STATUS_VARIANT = { SENT: 'success', FAILED: 'danger', SKIPPED: 'default' } as const;

// "Recent deliveries" (#1960): the last attempts of one workspace, from
// GET /api/admin/integrations/chat/deliveries — event key, recipient name,
// outcome, reason; never the card body. A FAILED row offers Retry, which goes
// through the router and appends a NEW row (the list reloads to show it).
function DeliveryLedger({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const c = t.integrations.chat;
  const [items, setItems] = useState<ChatDeliveryView[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/integrations/chat/deliveries?workspaceId=${encodeURIComponent(workspaceId)}&limit=50`);
    setItems(res.ok ? ((await res.json()).items as ChatDeliveryView[]) : []);
  }, [workspaceId]);
  useEffect(() => {
    load();
  }, [load]);

  const retry = async (id: string) => {
    setBusy(id);
    const res = await fetch(`/api/admin/integrations/chat/deliveries/${id}/retry`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    const code = (res.ok ? `retry_${String(body.status ?? '').toLowerCase()}` : String(body.code ?? 'retry_error')) as keyof typeof c.retryResult;
    setNote(c.retryResult[code] ?? c.retryResult.retry_error);
    await load();
  };

  if (!items) return <p className="text-xs text-gray-500 dark:text-gray-400">…</p>;
  if (items.length === 0) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400" data-testid={`chat-ledger-empty-${workspaceId}`}>
        {c.ledgerEmpty}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      {note && (
        <p role="status" className="mb-2 text-xs text-gray-600 dark:text-gray-300" data-testid="chat-retry-note">
          {note}
        </p>
      )}
      <table className="w-full text-xs" data-testid={`chat-ledger-${workspaceId}`}>
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400">
            <th className="py-1 pr-3 font-medium">{c.colWhen}</th>
            <th className="py-1 pr-3 font-medium">{c.colEvent}</th>
            <th className="py-1 pr-3 font-medium">{c.colRecipient}</th>
            <th className="py-1 pr-3 font-medium">{c.colStatus}</th>
            <th className="py-1 font-medium">{c.colReason}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {items.map((d) => (
            <tr key={d.id} data-testid={`chat-delivery-${d.id}`} data-status={d.status}>
              <td className="py-1 pr-3 whitespace-nowrap text-gray-600 dark:text-gray-300"><RelativeTime date={d.createdAt} /></td>
              <td className="py-1 pr-3 font-mono text-gray-700 dark:text-gray-200">{d.eventKey}</td>
              <td className="py-1 pr-3 text-gray-700 dark:text-gray-200">{d.recipient ?? '—'}</td>
              <td className="py-1 pr-3"><Badge variant={STATUS_VARIANT[d.status]}>{c.status[d.status]}</Badge></td>
              <td className="py-1 text-gray-600 dark:text-gray-300">
                {d.error ? <span className="font-mono break-all" data-testid={`chat-delivery-error-${d.id}`}>{d.error}</span> : null}
                {d.status === 'FAILED' && (
                  <Button size="sm" variant="outline" className="ml-2" disabled={busy === d.id} onClick={() => retry(d.id)} data-testid={`chat-retry-${d.id}`}>
                    {c.retry}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChatAppsCard() {
  const t = useT();
  const c = t.integrations.chat;
  const [data, setData] = useState<ChatStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ChatWorkspaceView | null>(null);
  // The install callback (#1935) lands here with ?chat=<outcome>. Read once on
  // mount from location (no Suspense boundary needed for a one-off banner).
  const [banner, setBanner] = useState<keyof typeof c.banner | null>(null);
  const banners = c.banner;
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('chat');
    if (v && v in banners) setBanner(v as keyof typeof banners);
  }, [banners]);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/integrations/chat/status');
    if (!res.ok) {
      setError(c.loadError);
      return;
    }
    setError(null);
    setData(await res.json());
  }, [c.loadError]);
  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (ws: ChatWorkspaceView) => {
    setBusy(ws.id);
    const res = await fetch(`/api/admin/integrations/chat/${ws.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !ws.enabled }),
    });
    setBusy(null);
    if (!res.ok) setError(res.status === 403 ? c.forbidden : c.actionError);
    await load();
  };

  const uninstall = async () => {
    if (!confirm) return;
    setBusy(confirm.id);
    const res = await fetch(`/api/admin/integrations/chat/${confirm.id}`, { method: 'DELETE' });
    setBusy(null);
    setConfirm(null);
    if (!res.ok) setError(res.status === 403 ? c.forbidden : c.actionError);
    await load();
  };

  return (
    <Card data-testid="chat-apps-card">
      <CardHeader>
        <CardTitle>{c.title}</CardTitle>
      </CardHeader>
      <p className="text-sm text-gray-600 dark:text-gray-300">{c.intro}</p>
      {data && (
        <div className="mt-3 flex flex-wrap gap-2">
          {data.platforms.map((p) => (
            <Badge key={p.platform} variant={p.configured ? 'success' : 'default'} data-testid={`chat-platform-${p.platform}`}>
              {PLATFORM_LABEL[p.platform]}: {p.configured ? c.configured : c.notConfigured}
            </Badge>
          ))}
          {!data.deliveryEnabled && (
            <Badge variant="warning" data-testid="chat-delivery-off">
              {c.deliveryOff}
            </Badge>
          )}
        </div>
      )}
      {banner && (
        <p role="status" className="mt-3 text-sm text-gray-700 dark:text-gray-200" data-testid={`chat-banner-${banner}`}>
          {c.banner[banner]}
        </p>
      )}
      {data && data.deliveryEnabled && (
        <div className="mt-3 flex flex-wrap gap-2">
          {data.platforms
            .filter((p) => p.configured)
            .map((p) => (
              // A plain link: the route answers with a redirect to the platform's
              // consent screen, and decides on the server who may start it.
              <a
                key={p.platform}
                href={`/api/integrations/chat/${p.platform === 'SLACK' ? 'slack' : 'teams'}/connect`}
                className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
                data-testid={`chat-install-${p.platform}`}
              >
                {interpolate(c.install, { platform: PLATFORM_LABEL[p.platform] })}
              </a>
            ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {data && data.workspaces.length === 0 && (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400" data-testid="chat-none">
          {c.none}
        </p>
      )}
      <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
        {data?.workspaces.map((ws) => (
          <li key={ws.id} className="py-3" data-testid={`chat-workspace-${ws.id}`} data-enabled={ws.enabled ? '1' : '0'}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-gray-900 dark:text-gray-100">{ws.name}</span>
              <Badge variant="info">{PLATFORM_LABEL[ws.platform]}</Badge>
              <Badge variant={ws.enabled ? 'success' : 'warning'} data-testid={`chat-state-${ws.id}`}>
                {ws.enabled ? c.enabled : c.disabled}
              </Badge>
            </div>
            <dl className="mt-2 grid gap-1 text-xs text-gray-600 dark:text-gray-300 sm:grid-cols-2">
              <div>
                <dt className="inline text-gray-500 dark:text-gray-400">{c.installedBy}: </dt>
                <dd className="inline">{ws.installedBy ? ws.installedBy.name || ws.installedBy.email : '—'}</dd>{' '}
                · <RelativeTime date={ws.createdAt} />
              </div>
              <div>
                <dt className="inline text-gray-500 dark:text-gray-400">{c.identities}: </dt>
                <dd className="inline" data-testid={`chat-identities-${ws.id}`}>{ws.verifiedIdentities}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="inline text-gray-500 dark:text-gray-400">{c.scopes}: </dt>
                <dd className="inline font-mono break-all">{ws.scopes.join(', ') || '—'}</dd>
              </div>
              <div>
                <dt className="inline text-gray-500 dark:text-gray-400">{c.lastDelivery}: </dt>
                <dd className="inline">{ws.lastDeliveryAt ? <RelativeTime date={ws.lastDeliveryAt} /> : c.never}</dd>
              </div>
              {ws.lastError && (
                <div className="sm:col-span-2 text-red-600 dark:text-red-400" data-testid={`chat-error-${ws.id}`}>
                  {fillTemplate(c.lastError, { error: ws.lastError })}
                </div>
              )}
            </dl>
            <details className="mt-2" data-testid={`chat-ledger-toggle-${ws.id}`}>
              <summary className="cursor-pointer text-xs font-medium text-blue-600 dark:text-blue-400">{c.ledgerTitle}</summary>
              <div className="mt-2">
                <DeliveryLedger workspaceId={ws.id} />
              </div>
            </details>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" disabled={busy === ws.id} onClick={() => toggle(ws)} data-testid={`chat-toggle-${ws.id}`}>
                {ws.enabled ? c.disable : c.enable}
              </Button>
              <Button size="sm" variant="danger" disabled={busy === ws.id} onClick={() => setConfirm(ws)} data-testid={`chat-uninstall-${ws.id}`}>
                {c.uninstall}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirm !== null}
        title={c.uninstall}
        message={interpolate(c.uninstallConfirm, { name: confirm?.name ?? '' })}
        confirmLabel={c.uninstall}
        cancelLabel={t.common.cancel}
        variant="danger"
        loading={busy !== null}
        onConfirm={uninstall}
        onCancel={() => setConfirm(null)}
      />
    </Card>
  );
}
