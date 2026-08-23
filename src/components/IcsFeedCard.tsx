'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarPlus, Copy, RefreshCw, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// Subscribe-in-your-calendar-app card (#915). The URL embeds a personal,
// unguessable token; rotating invalidates the old URL immediately, revoking
// kills the feed. The feed itself is PII-minimal (title + time only).
export function IcsFeedCard() {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    fetch('/api/account/ics-feed')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setToken(d?.token ?? null))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const feedUrl = token ? `${window.location.origin}/api/calendar/feed/${token}` : null;

  const rotate = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/account/ics-feed', { method: 'POST' });
      if (res.ok) setToken((await res.json()).token);
    } finally {
      setBusy(false);
      setCopied(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/account/ics-feed', { method: 'DELETE' });
      if (res.ok) setToken(null);
    } finally {
      setBusy(false);
      setCopied(false);
    }
  };

  const copy = async () => {
    if (!feedUrl) return;
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (permissions/http) — the URL stays selectable below.
    }
  };

  return (
    <Card className="mt-6" data-testid="ics-feed-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CalendarPlus className="h-5 w-5 text-blue-600" />
          <CardTitle>{t.portal.icsFeed.title}</CardTitle>
        </div>
      </CardHeader>
      <p className="mb-3 text-sm text-gray-500">{t.portal.icsFeed.hint}</p>
      {!loaded ? (
        <p className="text-sm text-gray-400">{t.common.loading}</p>
      ) : !token ? (
        <Button type="button" loading={busy} onClick={rotate} data-testid="ics-feed-create">
          {t.portal.icsFeed.create}
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={feedUrl ?? ''}
              onFocus={(e) => e.target.select()}
              data-testid="ics-feed-url"
              className="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-xs font-mono text-gray-600 dark:text-gray-300"
            />
            <Button type="button" variant="outline" size="sm" onClick={copy}>
              <Copy className="h-4 w-4" />
              {copied ? t.portal.icsFeed.copied : t.portal.icsFeed.copy}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" loading={busy} onClick={rotate} data-testid="ics-feed-rotate">
              <RefreshCw className="h-4 w-4" />
              {t.portal.icsFeed.rotate}
            </Button>
            <Button type="button" variant="outline" size="sm" loading={busy} onClick={revoke} data-testid="ics-feed-revoke">
              <Trash2 className="h-4 w-4" />
              {t.portal.icsFeed.revoke}
            </Button>
          </div>
          <p className="text-xs text-gray-400">{t.portal.icsFeed.privacy}</p>
        </div>
      )}
    </Card>
  );
}
