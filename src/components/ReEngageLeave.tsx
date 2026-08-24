'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

export function ReEngageLeave({
  token,
  labels,
}: {
  token: string;
  labels: { button: string; done: string; failed: string };
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');

  const leave = async () => {
    setState('busy');
    try {
      const res = await fetch('/api/re-engagement/leave', {
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
      <p data-testid="re-engage-done" className="mt-5 inline-flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-200">
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
        data-testid="re-engage-leave"
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-black disabled:opacity-40 dark:bg-gray-100 dark:text-gray-900"
      >
        {state === 'busy' && <Loader2 className="h-4 w-4 animate-spin" />}
        {labels.button}
      </button>
      {state === 'failed' && (
        <p data-testid="re-engage-failed" className="mt-3 text-sm text-red-700 dark:text-red-300">{labels.failed}</p>
      )}
    </>
  );
}
