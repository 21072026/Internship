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
import type { ChatStatusView, ChatWorkspaceView } from '@/lib/chat/workspaces';

// The chat apps' install console on /admin/integrations (#1958): what is
// installed, by whom, with which scopes; the per-workspace kill switch; and the
// uninstall that revokes the token on the platform and deletes it here. Reads
// GET /api/admin/integrations/chat/status (never a token); writes PATCH/DELETE
// /api/admin/integrations/chat/[id], which decide on the server again.

const PLATFORM_LABEL = { SLACK: 'Slack', TEAMS: 'Microsoft Teams' } as const;

export function ChatAppsCard() {
  const t = useT();
  const c = t.integrations.chat;
  const [data, setData] = useState<ChatStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ChatWorkspaceView | null>(null);

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
