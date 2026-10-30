'use client';

import { useCallback, useEffect, useState } from 'react';
import { Webhook as WebhookIcon } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useT } from '@/i18n/client';

// A COMPANY owner's own webhooks (#2006). The event list offered is exactly the
// one the route answers with (`eventTypes`, COMPANY_WEBHOOK_EVENTS), so the
// form cannot ask for an event the route would refuse; which events actually
// reach the hook is decided again at delivery (src/lib/companyWebhookScope.ts).

interface HookRow {
  id: string;
  url: string;
  events: string[];
  disabledAt: string | null;
}

export function CompanyWebhooks({ onLocked }: { onLocked: () => void }) {
  const c = useT().companyIntegrations;
  const [hooks, setHooks] = useState<HookRow[] | null>(null);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [url, setUrl] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/company/integrations/webhooks');
    if (!res.ok) return;
    const body = await res.json();
    setHooks(body.webhooks);
    setEventTypes(body.eventTypes);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/company/integrations/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), events: picked }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 403 && body.code === 'feature_locked') return onLocked();
      if (res.status === 400 && body.code === 'invalid_url') return setError(c.hookInvalidUrl);
      if (!res.ok) return setError(c.error);
      setSecret(body.secret);
      setUrl('');
      setPicked([]);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm(c.hookDeleteConfirm)) return;
    const res = await fetch(`/api/company/integrations/webhooks?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) return setError(c.error);
    await load();
  }

  const toggle = (name: string) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));

  return (
    <Card className="p-4 space-y-4" data-testid="company-hooks">
      <div>
        <h2 className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <WebhookIcon className="h-5 w-5" aria-hidden /> {c.hooksTitle}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{c.hooksSubtitle}</p>
      </div>
      <form onSubmit={create} className="space-y-3" data-testid="company-hook-form">
        <Input label={c.hookUrl} type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} required data-testid="company-hook-url" />
        <fieldset>
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{c.hookEvents}</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {eventTypes.map((name) => (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={picked.includes(name)} onChange={() => toggle(name)} data-testid={`company-hook-event-${name}`} />
                <code className="text-xs">{name}</code>
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <Button type="submit" loading={saving} disabled={saving || !url.trim() || picked.length === 0} data-testid="company-hook-create">
          {c.hookCreate}
        </Button>
      </form>
      {secret && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950 p-3 space-y-1" data-testid="company-hook-secret">
          <p className="font-medium text-amber-900 dark:text-amber-100">{c.hookSecretTitle}</p>
          <p className="text-sm text-amber-900 dark:text-amber-100">{c.hookSecretBody}</p>
          <code className="block break-all text-xs bg-white dark:bg-gray-900 rounded p-2" data-private>
            {secret}
          </code>
        </div>
      )}
      {hooks && hooks.length === 0 && <p className="text-sm text-gray-500">{c.hooksEmpty}</p>}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-testid="company-hook-list">
        {(hooks ?? []).map((h) => (
          <li key={h.id} className="py-3 flex flex-wrap items-center gap-3" data-testid={`company-hook-${h.id}`}>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-gray-900 dark:text-gray-100 break-all">{h.url}</p>
              <p className="text-xs text-gray-500 break-words">{h.events.join(', ')}</p>
            </div>
            {h.disabledAt && <Badge variant="warning">{c.hookDisabled}</Badge>}
            <Button type="button" size="sm" variant="danger" onClick={() => void remove(h.id)} data-testid={`company-hook-delete-${h.id}`}>
              {c.hookDelete}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
