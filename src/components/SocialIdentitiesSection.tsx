'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useT } from '@/i18n/client';

// The person's own social sign-in identities (#1962), inside the sessions card
// on /account. Reads /api/account/identities; "Connect" goes through the
// provider's login route with ?link=1 (the signed-in account is recorded on
// the request row by the server, never sent from here). The last way in
// cannot be removed — the server refuses it (`last_sign_in_method`), this list
// only shows the answer.

interface Identity { id: string; provider: string; email: string | null; createdAt: string; lastUsedAt: string }
interface Provider { id: string; label: string }

export function SocialIdentitiesSection() {
  const t = useT();
  const a = t.account;
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/account/identities');
    if (!res.ok) return;
    const data = await res.json();
    setIdentities(data.identities ?? []);
    setProviders(data.providers ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (identities === null || (providers.length === 0 && identities.length === 0)) return null;
  const label = (id: string) => providers.find((p) => p.id === id)?.label ?? id;

  const unlink = async (id: string) => {
    setBusy(id);
    setError('');
    try {
      const res = await fetch(`/api/account/identities?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 409) setError(a.socialLastMethod);
      else if (!res.ok) setError(a.socialUnlinkFailed);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const linked = new Set(identities.map((i) => i.provider));

  return (
    <div className="mb-6" data-testid="social-identities">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{a.socialTitle}</h3>
      <p className="mt-1 mb-3 max-w-lg text-sm text-gray-600">{a.socialHint}</p>
      {identities.length > 0 && (
        <ul className="mb-3 max-w-lg divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {identities.map((i) => (
            <li key={i.id} data-testid={`social-identity-${i.provider}`} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-gray-900 dark:text-gray-100">{label(i.provider)}{i.email ? ` · ${i.email}` : ''}</p>
                <p className="text-xs text-gray-500">{fillTemplate(a.deviceLastUsed, { when: <RelativeTime date={i.lastUsedAt} /> })}</p>
              </div>
              <Button variant="outline" size="sm" loading={busy === i.id} onClick={() => unlink(i.id)}>
                {a.socialUnlink}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mb-2 text-sm text-red-600" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {providers.filter((p) => !linked.has(p.id)).map((p) => (
          <a
            key={p.id}
            href={`/api/auth/social/${p.id}/login?link=1`}
            data-testid={`social-connect-${p.id}`}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            {fillTemplate(a.socialConnect, { provider: p.label })}
          </a>
        ))}
      </div>
    </div>
  );
}
