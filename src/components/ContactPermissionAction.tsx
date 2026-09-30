'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

/**
 * The one button on /contact-permission/confirm and /contact-permission/opt-out
 * (#2577). The change is a POST from the browser, never the GET the e-mail link
 * points at: mail scanners prefetch every URL in a message, and a mutating GET
 * would confirm (or withdraw) for people who never clicked — the same reason as
 * `NewsletterUnsubscribe`.
 */
export function ContactPermissionAction({
  token,
  action,
  labels,
}: {
  token: string;
  action: 'confirm' | 'opt-out';
  labels: { button: string; done: string; doneHint?: string; failed: string; refused: string };
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'refused' | 'failed'>('idle');

  const call = async () => {
    setState('busy');
    try {
      const res = await fetch(`/api/contact-permission/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      setState(res.ok ? 'done' : res.status === 409 ? 'refused' : 'failed');
    } catch {
      setState('failed');
    }
  };

  if (state === 'done') {
    return (
      <div className="mt-5" data-testid="contact-permission-done">
        <p className="inline-flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-200">
          <Check className="h-4 w-4" />
          {labels.done}
        </p>
        {labels.doneHint && <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{labels.doneHint}</p>}
      </div>
    );
  }

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={call}
        disabled={state === 'busy'}
        data-testid="contact-permission-button"
        className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60 dark:bg-gray-100 dark:text-gray-900"
      >
        {state === 'busy' && <Loader2 className="h-4 w-4 animate-spin" />}
        {labels.button}
      </button>
      {state === 'refused' && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-300" data-testid="contact-permission-refused">
          {labels.refused}
        </p>
      )}
      {state === 'failed' && (
        <p className="mt-3 text-sm text-red-700 dark:text-red-300" data-testid="contact-permission-failed">
          {labels.failed}
        </p>
      )}
    </div>
  );
}
