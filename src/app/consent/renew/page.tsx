'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

function RenewInner() {
  const t = useT();
  const token = useSearchParams().get('token') || '';
  const [state, setState] = useState<'idle' | 'ok' | 'error'>('idle');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/consent/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      setState(res.ok ? 'ok' : 'error');
    } catch {
      setState('error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-3">{t.consentRenew.title}</h1>
        {state === 'ok' ? (
          <p className="text-sm text-green-700 dark:text-green-400">{t.consentRenew.success}</p>
        ) : (
          <>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">{t.consentRenew.body}</p>
            {state === 'error' && (
              <p className="mb-4 text-sm text-red-600">{t.consentRenew.error}</p>
            )}
            <Button onClick={submit} loading={loading} disabled={!token} className="w-full" size="lg">
              {t.consentRenew.button}
            </Button>
          </>
        )}
        <Link href="/" className="inline-block mt-6 text-sm text-blue-600 hover:underline">
          ← {t.consentRenew.back}
        </Link>
      </div>
    </div>
  );
}

export default function ConsentRenewPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">…</div>}>
      <RenewInner />
    </Suspense>
  );
}
