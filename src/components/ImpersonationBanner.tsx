'use client';

import { useEffect, useRef, useState } from 'react';
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
 *
 * Because it is mounted once and outlives every navigation, its state outlives
 * an impersonation too (#3876): `busy` is reset whenever the session's person
 * changes, or the second "Login as" of a tab found its button still disabled.
 * And when the 30-minute cap (IMPERSONATION_SESSION_MAX_MS) reverts the session,
 * the bar switches on time and says why, instead of vanishing mid-click.
 */

const DISMISSED_KEY = 'impersonation.endedNoticeDismissed';
/** How long after an auto-revert the notice is still worth showing. */
const ENDED_NOTICE_MS = 15 * 60 * 1000;
/** setTimeout's ceiling; the cap is far below it, but a bad value must not fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function readDismissed(): number | null {
  try {
    const v = Number(window.sessionStorage.getItem(DISMISSED_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeDismissed(endedAt: number) {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, String(endedAt));
  } catch {
    /* blocked storage: the notice simply comes back on the next load */
  }
}

export function ImpersonationBanner() {
  const t = useT();
  const router = useRouter();
  const { data: session, update } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const impersonating = Boolean(session?.user?.impersonatorName);
  const expiresAt = impersonating ? session?.user?.impersonationExpiresAt ?? null : null;
  const endedAt = !impersonating ? session?.user?.impersonationEndedAt ?? null : null;
  const [now, setNow] = useState(() => Date.now());
  const showEnded = endedAt !== null && dismissed !== endedAt && now - endedAt < ENDED_NOTICE_MS;
  useTopBannerInset(ref, impersonating || showEnded);

  useEffect(() => setDismissed(readDismissed()), []);

  // A new person in the session (start, stop, expiry): nothing of the last one's click carries over.
  const who = `${session?.user?.id ?? ''}|${session?.user?.impersonatorId ?? ''}`;
  useEffect(() => {
    setBusy(false);
    setError(null);
    setNow(Date.now());
  }, [who]);

  // At the cap, ask the server: its jwt callback reverts the token, and the
  // admin lands on their own screen at once rather than on their next click.
  useEffect(() => {
    if (expiresAt === null) return;
    const wait = Math.min(Math.max(expiresAt - Date.now() + 1000, 0), MAX_TIMER_MS);
    const timer = window.setTimeout(async () => {
      const next = await update();
      if (!next?.user?.impersonatorName) {
        router.push('/admin/users');
        router.refresh();
      }
    }, wait);
    return () => window.clearTimeout(timer);
  }, [expiresAt, update, router]);

  if (!impersonating && !showEnded) return null;

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

  if (!impersonating && endedAt !== null) {
    return (
      <div
        ref={ref}
        role="status"
        data-testid="impersonation-ended"
        className="no-print sticky top-0 z-50 border-b border-purple-300 dark:border-purple-700 bg-purple-100 dark:bg-purple-900/60 text-sm text-purple-900 dark:text-purple-100 pt-[env(safe-area-inset-top,0px)] pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]"
      >
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
          <UserCog className="h-4 w-4 shrink-0" />
          <span className="flex-1 min-w-0">{t.impersonation.expired}</span>
          <button
            type="button"
            onClick={() => {
              writeDismissed(endedAt);
              setDismissed(endedAt);
            }}
            className="font-semibold underline hover:no-underline"
            data-testid="impersonation-ended-dismiss"
          >
            {t.impersonation.dismiss}
          </button>
        </div>
      </div>
    );
  }

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
          {/* The target org's read_only policy (#1586): says why a save fails. */}
          {session?.user?.impersonationReadOnly && (
            <span data-testid="impersonation-read-only" className="ml-2 rounded bg-purple-200 px-1.5 py-0.5 text-xs font-semibold dark:bg-purple-800">
              {t.impersonation.readOnly}
            </span>
          )}
        </span>
        {error && <span className="text-red-700 dark:text-red-300">{error}</span>}
        <button onClick={stop} disabled={busy} className="font-semibold underline hover:no-underline disabled:opacity-50" data-testid="impersonation-return">
          {t.impersonation.return}
        </button>
      </div>
    </div>
  );
}
