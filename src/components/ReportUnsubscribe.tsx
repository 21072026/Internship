'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

/**
 * The button on /reports/unsubscribe (#1905). A POST from the browser, never
 * the GET the e-mail links to: link scanners prefetch every URL in a message,
 * and a mutating GET would unsubscribe people who never clicked.
 */
export function ReportUnsubscribe({ token, labels }: { token: string; labels: { button: string; done: string; failed: string } }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');

  const leave = async () => {
    setState('busy');
    try {
      const res = await fetch('/api/report-subscriptions/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      setState(res.ok ? 'done' : 'failed');
    } catch {
      setState('failed');
    }
  };

  if (state === 'done') {
    return (
      <p
        data-testid="report-unsub-done"
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-100"
      >
        <Check className="h-4 w-4" />
        {labels.done}
      </p>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={leave}
        disabled={state === 'busy'}
        data-testid="report-unsub"
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-black disabled:opacity-40 dark:bg-gray-100 dark:text-gray-900"
      >
        {state === 'busy' && <Loader2 className="h-4 w-4 animate-spin" />}
        {labels.button}
      </button>
      {state === 'failed' && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
          {labels.failed}
        </p>
      )}
    </>
  );
}
