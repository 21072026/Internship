'use client';

import { Suspense, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';

// Landing page the ACS route redirects to after verifying the SAML assertion.
// It consumes the single-use grant via the `sso` NextAuth provider to establish
// the session, then lands the user in the app.
function Complete() {
  const params = useSearchParams();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setFailed(true);
      return;
    }
    signIn('sso', { grant: token, callbackUrl: '/', redirect: true }).catch(() => setFailed(true));
  }, [params]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="text-center">
        {failed ? (
          <>
            <p className="text-gray-900 dark:text-gray-100 font-medium">Could not complete sign-in.</p>
            <a href="/auth/signin" className="text-blue-600 hover:underline text-sm">Back to sign in</a>
          </>
        ) : (
          <p className="text-gray-600 dark:text-gray-300">Signing you in…</p>
        )}
      </div>
    </div>
  );
}

export default function SsoCompletePage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900"><p className="text-gray-600 dark:text-gray-300">Signing you in…</p></div>}>
      <Complete />
    </Suspense>
  );
}
