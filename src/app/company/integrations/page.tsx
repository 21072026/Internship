'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

// A COMPANY owner's own API keys (#2006). Everything that matters is decided by
// /api/company/integrations/api-keys — which company, the scope ceiling, the
// expiry cap; this page only renders what the route answers and never offers
// a scope the route would refuse.

interface KeyRow {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

type Blocked = 'locked' | 'admin' | 'notAssigned' | null;

const DAY = 24 * 3600 * 1000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default function CompanyIntegrationsPage() {
  const t = useT();
  const locale = useLocale();
  const c = t.companyIntegrations;
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [blocked, setBlocked] = useState<Blocked>(null);
  const [error, setError] = useState(false);
  const [name, setName] = useState('');
  const [expires, setExpires] = useState(isoDay(new Date(Date.now() + 90 * DAY)));
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/company/integrations/api-keys');
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      setBlocked(body.code === 'company_not_assigned' ? 'notAssigned' : 'admin');
      return;
    }
    if (!res.ok) return setError(true);
    setKeys((await res.json()).keys);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(false);
    try {
      // End of the chosen day, in the browser's own zone.
      const expiresAt = new Date(`${expires}T23:59:59`).toISOString();
      const res = await fetch('/api/company/integrations/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scopes: ['hiring:read'], expiresAt }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 403 && body.code === 'feature_locked') return setBlocked('locked');
      if (!res.ok) return setError(true);
      setFresh(body.key);
      setCopied(false);
      setName('');
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm(c.revokeConfirm)) return;
    const res = await fetch(`/api/company/integrations/api-keys?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) return setError(true);
    await load();
  }

  const statusLabel = { active: c.statusActive, expired: c.statusExpired, revoked: c.statusRevoked } as const;
  const minDay = isoDay(new Date(Date.now() + DAY));
  const maxDay = isoDay(new Date(Date.now() + 365 * DAY));

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8 space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <KeyRound className="h-6 w-6" aria-hidden /> {c.title}
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{c.subtitle}</p>
      </header>

      {blocked === 'admin' && (
        <Card className="p-4 text-sm" data-testid="company-integrations-admin">
          <Link href="/admin/integrations" className="text-blue-600 underline">
            {c.adminHint}
          </Link>
        </Card>
      )}
      {blocked === 'notAssigned' && <Card className="p-4 text-sm">{c.notAssigned}</Card>}
      {blocked === 'locked' && (
        <Card className="p-4 text-sm" data-testid="company-integrations-locked">
          {c.locked}
        </Card>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {c.error}
        </p>
      )}

      {!blocked && (
        <>
          <Card className="p-4 space-y-4">
            <h2 className="font-semibold text-gray-900 dark:text-gray-100">{c.newKey}</h2>
            <form onSubmit={create} className="grid gap-4 md:grid-cols-2" data-testid="company-key-form">
              <Input label={c.name} placeholder={c.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required data-testid="company-key-name" />
              <Input label={c.expires} type="date" value={expires} min={minDay} max={maxDay} onChange={(e) => setExpires(e.target.value)} required data-testid="company-key-expires" />
              <p className="text-sm text-gray-600 dark:text-gray-400 md:col-span-2">
                <span className="font-medium">{c.scope}:</span> {c.scopeHiring}
              </p>
              <div className="md:col-span-2">
                <Button type="submit" loading={creating} disabled={creating || !name.trim()} data-testid="company-key-create">
                  {creating ? c.creating : c.create}
                </Button>
              </div>
            </form>
            {fresh && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950 p-3 space-y-2" data-testid="company-key-fresh">
                <p className="font-medium text-amber-900 dark:text-amber-100">{c.createdTitle}</p>
                <p className="text-sm text-amber-900 dark:text-amber-100">{c.createdBody}</p>
                <div className="flex gap-2 items-center">
                  <code className="flex-1 break-all text-xs bg-white dark:bg-gray-900 rounded p-2" data-private>
                    {fresh}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void navigator.clipboard?.writeText(fresh);
                      setCopied(true);
                    }}
                  >
                    {copied ? c.copied : c.copy}
                  </Button>
                </div>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-3">{c.keysTitle}</h2>
            {keys && keys.length === 0 && <p className="text-sm text-gray-500">{c.empty}</p>}
            <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-testid="company-key-list">
              {(keys ?? []).map((k) => (
                <li key={k.id} className="py-3 flex flex-wrap items-center gap-3" data-testid={`company-key-${k.id}`}>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 dark:text-gray-100 truncate">{k.name}</p>
                    <p className="text-xs text-gray-500">
                      {k.expiresAt && (
                        <>
                          {c.expires}: {formatDate(k.expiresAt, locale)} ·{' '}
                        </>
                      )}
                      {c.lastUsed}: {k.lastUsedAt ? <RelativeTime date={k.lastUsedAt} /> : c.never}
                    </p>
                  </div>
                  <Badge variant={k.status === 'active' ? 'success' : 'default'}>{statusLabel[k.status]}</Badge>
                  {k.status === 'active' && (
                    <Button type="button" size="sm" variant="danger" onClick={() => void revoke(k.id)} data-testid={`company-key-revoke-${k.id}`}>
                      {c.revoke}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
