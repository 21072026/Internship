'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';

// Accepting the partner contract (#3117). The version shown is the version
// accepted: a newer one published meanwhile answers 409 `stale_version`, and the
// page reloads to show it rather than recording consent to a text never read.
export function AcceptContract({ version, impersonating }: { version: number; impersonating: boolean }) {
  const t = useT();
  const L = t.affiliatePortal;
  const router = useRouter();
  const toast = useToast();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (impersonating) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.contractImpersonating}</p>;

  async function accept() {
    setBusy(true);
    try {
      const res = await fetch('/api/affiliate/contract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        router.replace('/affiliate');
        router.refresh();
        return;
      }
      if (body.code === 'stale_version') {
        toast(L.contractStale, 'error');
        setAgreed(false);
        router.refresh();
      } else toast(L.contractFailed, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
        <input type="checkbox" className="mt-0.5" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="affiliate-contract-agree" />
        {L.contractAgree}
      </label>
      <Button type="button" disabled={!agreed || busy} onClick={() => void accept()} data-testid="affiliate-contract-accept">
        {L.contractAccept}
      </Button>
    </div>
  );
}
