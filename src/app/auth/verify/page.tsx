'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, XCircle } from 'lucide-react';
import { BrandTile } from '@/components/BrandMark';
import { useT } from '@/i18n/client';

function VerifyInner() {
  const t = useT();
  const token = useSearchParams().get('token') || '';
  const [state, setState] = useState<'loading' | 'ok' | 'fail'>('loading');

  useEffect(() => {
    if (!token) {
      setState('fail');
      return;
    }
    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((r) => setState(r.ok ? 'ok' : 'fail'))
      .catch(() => setState('fail'));
  }, [token]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-3">
            <BrandTile />
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
          {state === 'loading' && <p className="text-gray-500">{t.auth.verifying}</p>}
          {state === 'ok' && (
            <>
              <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-3" />
              <h1 className="text-xl font-bold text-gray-900 mb-1">{t.auth.verifiedTitle}</h1>
              <p className="text-gray-500 text-sm">{t.auth.verifiedBody}</p>
            </>
          )}
          {state === 'fail' && (
            <>
              <XCircle className="h-12 w-12 text-red-500 mx-auto mb-3" />
              <h1 className="text-xl font-bold text-gray-900 mb-1">{t.auth.verifyFailTitle}</h1>
              <p className="text-gray-500 text-sm">{t.auth.verifyFailBody}</p>
            </>
          )}
          <p className="mt-6">
            <Link href="/auth/signin" className="text-blue-600 hover:underline font-medium text-sm">
              {t.auth.backToSignin}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <VerifyInner />
    </Suspense>
  );
}
