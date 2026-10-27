'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useT } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { minutesLeft, planSessionWarning } from '@/lib/sessionTimeoutRule';

/**
 * "Your session is about to end" (WCAG 2.2.1 Timing Adjustable, #2864),
 * mounted once in app/providers.tsx and silent unless signed in.
 *
 * The timing is the pure rule in lib/sessionTimeoutRule.ts: five minutes before
 * the session's `expires` an alert dialog offers "Stay signed in", which is
 * next-auth's `update()` — the cookie comes back with a fresh 12 h. A focus
 * refetch that already moved `expires` re-plans and closes the dialog on its
 * own. A tab that slept through its timer re-plans when it becomes visible.
 *
 * Dark mode: the panel rides the flat `html.dark .bg-white` / `.text-gray-*`
 * overrides in globals.css, like the shortcut sheet.
 */
export function SessionTimeoutWarning() {
  const { status, data, update } = useSession();
  const t = useT();
  const s = t.sessionTimeout;
  const toast = useToast();
  const ids = useId();
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [extending, setExtending] = useState(false);
  const expires = status === 'authenticated' ? data?.expires : undefined;

  const close = useCallback(() => setRemainingMs(null), []);
  const dialogRef = useModalFocus<HTMLDivElement>(remainingMs !== null, close);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const plan = () => {
      if (timer) clearTimeout(timer);
      const next = planSessionWarning(expires, Date.now());
      if (next.kind === 'wait') {
        setRemainingMs(null);
        timer = setTimeout(plan, next.delayMs);
      } else if (next.kind === 'warn') {
        setRemainingMs(next.remainingMs);
      } else {
        setRemainingMs(null);
      }
    };
    plan();
    const onVisible = () => { if (document.visibilityState === 'visible') plan(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [expires]);

  const stay = async () => {
    setExtending(true);
    try {
      const fresh = await update();
      setRemainingMs(null);
      if (fresh) toast(s.extended, 'success');
    } finally {
      setExtending(false);
    }
  };

  if (remainingMs === null) return null;

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        aria-describedby={`${ids}-body`}
        data-testid="session-timeout-warning"
        tabIndex={-1}
        className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl"
      >
        <h2 id={`${ids}-title`} className="text-base font-semibold text-gray-900">{s.title}</h2>
        <p id={`${ids}-body`} className="mt-2 text-sm text-gray-700">
          {s.body.replace('{minutes}', String(minutesLeft(remainingMs)))}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={close} data-testid="session-timeout-dismiss">
            {s.dismiss}
          </Button>
          <Button onClick={stay} loading={extending} data-testid="session-timeout-stay">
            {s.stay}
          </Button>
        </div>
      </div>
    </div>
  );
}
