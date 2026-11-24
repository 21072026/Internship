'use client';
import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';

export function SubscriberAction({ token, action }: { token: string; action: 'confirm' | 'unsubscribe' }) {
  const t = useT().interest;
  const [state, setState] = useState<'idle'|'done'|'failed'>('idle');
  const apply = useCallback(async () => {
    try {
      const res = await fetch(action === 'confirm' ? '/api/subscribe/confirm' : `/api/subscribe/unsubscribe?t=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error(); setState('done');
    } catch { setState('failed'); }
  }, [action, token]);
  useEffect(() => {
    // Like /u/<token>: a human's browser applies opt-out, a GET scanner doesn't.
    if (action === 'unsubscribe') void apply();
  }, [action, apply]);
  return <div className="max-w-xl mx-auto p-8"><h1 className="text-xl font-semibold">{action === 'confirm' ? t.confirmSubject : t.unsubscribe}</h1>
    <p role="status" className="my-4">{state === 'done' ? t.actionDone : state === 'failed' ? t.failed : t.confirmBody}</p>
    {(action === 'confirm' && state !== 'done' || state === 'failed') && <button className="rounded border p-2" onClick={() => void apply()}>{action === 'confirm' ? t.confirmButton : t.unsubscribe}</button>}
  </div>;
}
