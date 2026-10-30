'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useT } from '@/i18n/client';

// The person's own profile digest (#2038): the summary and themes the
// semantic match rule compares them by, shown exactly as stored, with one
// button to make it again. Reads and writes only the signed-in user's own row
// (/api/profile/digest takes no id).

interface Digest {
  digest: string;
  themes: string[];
  updatedAt: string;
}

export function ProfileDigestCard() {
  const t = useT();
  const L = t.profileDigest;
  const [digest, setDigest] = useState<Digest | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/profile/digest');
    const body = res.ok ? await res.json() : null;
    // No card at all where matching is not part of the product.
    setDigest(body?.available ? body.digest : undefined);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const regenerate = async () => {
    setBusy(true);
    setMsg('');
    const res = await fetch('/api/profile/digest', { method: 'POST' });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (body && 'digest' in body) setDigest(body.digest);
    const code: string = res.ok ? body?.status ?? '' : body?.code ?? '';
    setMsg((L.results as Record<string, string>)[code] ?? (res.ok ? '' : L.results.unavailable));
  };

  if (digest === undefined) return null;
  return (
    <Card className="max-w-2xl mt-6" data-testid="profile-digest">
      <CardHeader>
        <CardTitle>{L.title}</CardTitle>
        <CardDescription>{L.intro}</CardDescription>
      </CardHeader>
      <div className="space-y-3 px-6 pb-6 text-sm">
        {digest ? (
          <>
            <p data-testid="profile-digest-text">{digest.digest}</p>
            <ul className="flex flex-wrap gap-2" aria-label={L.themes} data-testid="profile-digest-themes">
              {digest.themes.map((theme) => (
                <li key={theme}><Badge>{theme}</Badge></li>
              ))}
            </ul>
            <p className="text-xs text-gray-500">{fillTemplate(L.updated, { when: <RelativeTime date={new Date(digest.updatedAt)} /> })}</p>
          </>
        ) : (
          <p className="text-gray-600" data-testid="profile-digest-empty">{L.none}</p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" onClick={regenerate} loading={busy} data-testid="profile-digest-regenerate">
            <RefreshCw className="mr-1 h-4 w-4" aria-hidden />
            {digest ? L.regenerate : L.generate}
          </Button>
          {msg && <p role="status" className="text-gray-600" data-testid="profile-digest-message">{msg}</p>}
        </div>
      </div>
    </Card>
  );
}
