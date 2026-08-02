'use client';

import { useRef, useState } from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { UserCog } from 'lucide-react';
import { useT } from '@/i18n/client';
import { useTopBannerInset } from '@/hooks/useTopBannerInset';

/**
 * Persistent bar shown while an admin is impersonating another user, with a
 * one-click way back to their own account.
 *
 * Rendered once, app-wide (`Providers`), as the first thing in the document —
 * not inside a page shell. It used to live in `ResponsiveShell`, which meant it
 * simply did not exist on the screens that render their own chrome (/messages,
 * /account, /notifications, /announcements): an admin who opened Messages while
 * impersonating lost both the "you are someone else" warning and the way back.
 * It is `sticky` so it stays on screen while a page scrolls, and publishes its
 * height as `--top-banner-inset` for the viewport-sized chat frame.
 */
export function ImpersonationBanner() {
  const t = useT();
  const router = useRouter();
  const { data: session } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const impersonating = Boolean(session?.user?.impersonatorName);
  useTopBannerInset(ref, impersonating);

  if (!impersonating) return null;

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
    <div
      ref={ref}
      data-testid="impersonation-banner"
      className="no-print sticky top-0 z-50 border-b border-purple-300 dark:border-purple-700 bg-purple-100 dark:bg-purple-900/60 text-sm text-purple-900 dark:text-purple-100 pt-[env(safe-area-inset-top,0px)] pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
        <UserCog className="h-4 w-4 shrink-0" />
        <span className="flex-1 min-w-0">
          {t.impersonation.viewingAs.replace('{name}', session?.user?.name ?? '')}
        </span>
        {error && <span className="text-red-700 dark:text-red-300">{error}</span>}
        <button onClick={stop} disabled={busy} className="font-semibold underline hover:no-underline disabled:opacity-50">
          {t.impersonation.return}
        </button>
      </div>
    </div>
  );
}
