'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { interpolate } from '@/lib/notificationText';
import type { MyChatIdentity } from '@/lib/chat/identity';

// The person's own Slack / Teams links on their account page (#1937). Renders
// nothing until their organisation's admin has proposed a link — so nobody
// sees a chat card for an app their org does not use. Confirm is what makes a
// link deliver; Disconnect deletes it (GET/POST/DELETE
// /api/integrations/chat/identity, own identities only, decided on the server).

const PLATFORM_LABEL = { SLACK: 'Slack', TEAMS: 'Microsoft Teams' } as const;

export function ChatConnectionsCard() {
  const t = useT();
  const c = t.account.chat;
  const [items, setItems] = useState<MyChatIdentity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/integrations/chat/identity', { cache: 'no-store' });
    if (res.ok) setItems((await res.json()).items ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (identityId: string, method: 'POST' | 'DELETE') => {
    setBusy(identityId);
    const res = await fetch('/api/integrations/chat/identity', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityId }),
    });
    setBusy(null);
    setError(!res.ok);
    await load();
  };

  if (items.length === 0) return null;
  return (
    <Card className="mt-6 max-w-4xl" data-testid="chat-connections">
      <CardHeader>
        <CardTitle>{c.title}</CardTitle>
      </CardHeader>
      <p className="text-sm text-gray-600 dark:text-gray-300">{c.intro}</p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {c.error}
        </p>
      )}
      <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-800">
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 py-3" data-testid={`chat-identity-${i.id}`} data-confirmed={i.confirmed ? '1' : '0'}>
            <span className="min-w-0 flex-1 text-sm text-gray-900 dark:text-gray-100">
              {interpolate(c.connectedAs, {
                workspace: `${i.workspaceName} (${PLATFORM_LABEL[i.platform]})`,
                name: i.displayName ?? '—',
              })}
            </span>
            <Badge variant={i.confirmed ? 'success' : 'warning'}>{i.confirmed ? c.confirmed : c.pending}</Badge>
            {!i.confirmed && (
              <Button size="sm" disabled={busy === i.id} onClick={() => act(i.id, 'POST')} data-testid={`chat-identity-confirm-${i.id}`}>
                {c.confirm}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy === i.id} onClick={() => act(i.id, 'DELETE')} data-testid={`chat-identity-disconnect-${i.id}`}>
              {i.confirmed ? c.disconnect : c.notMe}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
