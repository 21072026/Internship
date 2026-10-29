'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useLocale, useT } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

// The demo's "get a sandbox key" control (#1992). The server decides whether a
// key may exist at all (POST /api/developers/sandbox-key answers 404 off the
// demo); this only asks and shows the raw key the one time it is returned.
export function SandboxKeyButton() {
  const t = useT();
  const D = t.developers;
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<{ key: string; expiresAt: string } | null>(null);
  const [failed, setFailed] = useState(false);

  const mint = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch('/api/developers/sandbox-key', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      setMinted(await res.json());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (minted) {
    return (
      <div className="mt-3 space-y-1 text-sm" data-testid="developers-sandbox-key">
        <p className="text-gray-700 dark:text-gray-300">{D.sandboxShownOnce}</p>
        <code className="block break-all rounded bg-gray-100 px-3 py-2 font-mono text-xs text-gray-900 dark:bg-gray-800 dark:text-gray-100" data-private>
          {minted.key}
        </code>
        <p className="text-xs text-gray-500">{D.sandboxExpires.replace('{when}', formatDateTime(minted.expiresAt, locale))}</p>
      </div>
    );
  }
  return (
    <div className="mt-3">
      <Button onClick={mint} disabled={busy} data-testid="developers-sandbox-button">
        {D.sandboxButton}
      </Button>
      {failed && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {D.sandboxFailed}
        </p>
      )}
    </div>
  );
}
