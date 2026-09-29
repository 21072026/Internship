'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { absoluteHere } from '@/lib/safeRedirect';

// Landing page the ACS route redirects to after verifying the SAML assertion.
// It consumes the single-use grant via the `sso` NextAuth provider to establish
// the session, then lands the user in the app.
function Complete() {
  const params = useSearchParams();
  const [failed, setFailed] = useState(false);
  // The grant is single-use, so this page redeems it exactly once (#2548). The
  // effect can run twice for one visit — React StrictMode re-runs it in dev, and
  // a new `useSearchParams()` identity re-runs it anywhere — and a second
  // `signIn('sso')` is not harmless: the loser's redirect: true navigates to the
  // error page and aborts the winner's in-flight callback before its session
  // cookie lands, leaving a spent grant and no session.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = params.get('token');
    if (!token) {
      setFailed(true);
      return;
    }
    signIn('sso', { grant: token, callbackUrl: absoluteHere('/'), redirect: true }).catch(() => setFailed(true));
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
