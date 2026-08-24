'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, UserMinus } from 'lucide-react';

/**
 * Clear an admin-set reminder date (#834).
 *
 * Deliberately does NOT revoke the person's consent: an admin deciding this
 * particular date is wrong is not the person withdrawing permission. Only the
 * one-click link in their own e-mail does that.
 */
export function PoolRemoveButton({ userId, label }: { userId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      data-testid={`pool-remove-${userId}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch('/api/re-engagement', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, action: 'leave' }),
          });
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserMinus className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}
