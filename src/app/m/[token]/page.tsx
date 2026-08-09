'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { GraduationCap, CheckCircle2, XCircle } from 'lucide-react';
import { useT } from '@/i18n/client';

// Landing page for the one-click links in a notification email (#1204):
// "mark as read" and the five emoji reactions.
//
// The action runs from the browser rather than from the link itself, because
// mail clients and corporate link scanners (Outlook Safe Links, antivirus
// gateways) fetch every URL in a message on arrival. A mutating GET would post
// reactions nobody clicked; a scanner does not execute scripts, so doing the
// work here keeps one-click UX without the phantom clicks.
type Result =
  | { state: 'pending' }
  | { state: 'read'; marked: number }
  | { state: 'reacted'; emoji: string; active: boolean }
  | { state: 'error'; message: string };

export default function EmailActionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const [result, setResult] = useState<Result>({ state: 'pending' });
  // React 18 StrictMode mounts effects twice in development; without this the
  // second run would toggle the reaction straight back off.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    fetch('/api/email-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setResult({ state: 'error', message: data.error ?? t.emailAction.failed });
          return;
        }
        setResult(
          data.kind === 'read'
            ? { state: 'read', marked: data.marked ?? 0 }
            : { state: 'reacted', emoji: data.emoji, active: data.active },
        );
      })
      .catch(() => setResult({ state: 'error', message: t.emailAction.failed }));
  }, [token, t]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 p-8 text-center shadow-sm">
        <GraduationCap className="mx-auto mb-4 h-8 w-8 text-blue-600" aria-hidden />

        {result.state === 'pending' && (
          <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="email-action-pending">
            {t.emailAction.working}
          </p>
        )}

        {result.state === 'read' && (
          <div data-testid="email-action-read">
            <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-green-600" aria-hidden />
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t.emailAction.readTitle}</h1>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              {result.marked > 0
                ? t.emailAction.readBody.replace('{n}', String(result.marked))
                : t.emailAction.readAlready}
            </p>
          </div>
        )}

        {result.state === 'reacted' && (
          <div data-testid="email-action-reacted">
            <div className="mb-3 text-5xl" aria-hidden>{result.emoji}</div>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {result.active ? t.emailAction.reactedTitle : t.emailAction.reactionRemovedTitle}
            </h1>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              {result.active ? t.emailAction.reactedBody : t.emailAction.reactionRemovedBody}
            </p>
          </div>
        )}

        {result.state === 'error' && (
          <div data-testid="email-action-error">
            <XCircle className="mx-auto mb-3 h-10 w-10 text-red-600" aria-hidden />
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t.emailAction.failed}</h1>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{result.message}</p>
          </div>
        )}

        {result.state !== 'pending' && (
          <Link
            href="/messages"
            className="mt-6 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {t.emailAction.openMessages}
          </Link>
        )}
      </div>
    </main>
  );
}
