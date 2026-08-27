'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

/**
 * The button on /newsletter/unsubscribe (#1469).
 *
 * The withdrawal is a POST from the browser, not the GET the e-mail link points
 * at: mail clients and corporate link scanners prefetch every URL in a message,
 * and a mutating GET would unsubscribe people who never clicked. Same shape as
 * `ReEngageLeave` for the same reason.
 *
 * The confirmation offers the way back, because someone who unsubscribed by
 * mistake (or whose scanner did it for them) should not need a support ticket
 * to fix it.
 */
export function NewsletterUnsubscribe({
  token,
  labels,
}: {
  token: string;
  labels: {
    button: string;
    done: string;
    doneHint: string;
    failed: string;
    resubscribe: string;
    resubscribed: string;
  };
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'back' | 'failed'>('idle');

  const call = async (resubscribe: boolean) => {
    setState('busy');
    try {
      const res = await fetch('/api/newsletter/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...(resubscribe ? { resubscribe: true } : {}) }),
      });
      setState(res.ok ? (resubscribe ? 'back' : 'done') : 'failed');
    } catch {
      setState('failed');
    }
  };

  if (state === 'back') {
    return (
      <p
        data-testid="newsletter-resubscribed"
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-200"
      >
        <Check className="h-4 w-4" />
        {labels.resubscribed}
      </p>
    );
  }

  if (state === 'done') {
    return (
      <div className="mt-5">
        <p
          data-testid="newsletter-unsub-done"
          className="inline-flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-100"
        >
          <Check className="h-4 w-4" />
          {labels.done}
        </p>
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{labels.doneHint}</p>
        <button
          type="button"
          onClick={() => call(true)}
          data-testid="newsletter-unsub-undo"
          className="mt-2 text-sm font-medium text-blue-700 underline hover:no-underline dark:text-blue-300"
        >
          {labels.resubscribe}
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => call(false)}
        disabled={state === 'busy'}
        data-testid="newsletter-unsub"
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-black disabled:opacity-40 dark:bg-gray-100 dark:text-gray-900"
      >
        {state === 'busy' && <Loader2 className="h-4 w-4 animate-spin" />}
        {labels.button}
      </button>
      {state === 'failed' && (
        <p data-testid="newsletter-unsub-failed" className="mt-3 text-sm text-red-700 dark:text-red-300">
          {labels.failed}
        </p>
      )}
    </>
  );
}
