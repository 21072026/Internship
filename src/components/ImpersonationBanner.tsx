'use client';

import { useState } from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { UserCog } from 'lucide-react';
import { useT } from '@/i18n/client';

// Persistent bar shown while an admin is impersonating another user, with a
// one-click way back to their own account.
export function ImpersonationBanner() {
  const t = useT();
  const router = useRouter();
  const { data: session } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session?.user?.impersonatorName) return null;

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/impersonate/stop', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const signed = await signIn('impersonate', { grant: data.grant, redirect: false });
        if (signed?.ok) {
          router.push('/admin/users');
          router.refresh();
          return;
        }
      }
      setError(t.impersonation.stopFailed);
    } catch {
      setError(t.impersonation.stopFailed);
    }
    setBusy(false);
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-purple-300 dark:border-purple-700 bg-purple-100 dark:bg-purple-900/40 px-4 py-3 text-sm text-purple-900 dark:text-purple-100">
      <UserCog className="h-4 w-4 shrink-0" />
      <span className="flex-1 min-w-0">
        {t.impersonation.viewingAs.replace('{name}', session.user.name ?? '')}
      </span>
      {error && <span className="text-red-700 dark:text-red-300">{error}</span>}
      <button onClick={stop} disabled={busy} className="font-semibold underline hover:no-underline disabled:opacity-50">
        {t.impersonation.return}
      </button>
    </div>
  );
}
