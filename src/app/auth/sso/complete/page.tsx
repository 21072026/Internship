'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { absoluteHere } from '@/lib/safeRedirect';

// Landing page the ACS route redirects to after verifying the SAML assertion.
// It consumes the single-use grant via the `sso` NextAuth provider to establish
// the session, then lands the user in the app.
function Complete() {
  const params = useSearchParams();
  // The redemption waits for the SessionProvider's first /api/auth/session
  // round-trip (#2858). A tab opened from the IdP's redirect holds no NextAuth
  // cookies yet, and two NextAuth requests in flight at once (that one and
  // signIn()'s own /api/auth/providers call) EACH mint a CSRF cookie: the
  // callback POST then carries one token in its body and the other in its
  // cookie, NextAuth bounces to `signin?csrf=true`, and no session exists —
  // seen on the CI production build. Once the first round-trip has landed,
  // every later call reuses its cookie. Same gate as /auth/magic/complete.
  const { status: sessionStatus } = useSession();
  const [failed, setFailed] = useState(false);
  // The grant is single-use, so this page redeems it exactly once (#2548). The
  // effect can run twice for one visit — React StrictMode re-runs it in dev, and
  // a new `useSearchParams()` identity re-runs it anywhere — and a second
  // `signIn('sso')` is not harmless: the loser's redirect: true navigates to the
  // error page and aborts the winner's in-flight callback before its session
  // cookie lands, leaving a spent grant and no session.
  const started = useRef(false);

  useEffect(() => {
    if (sessionStatus === 'loading' || started.current) return;
    started.current = true;
    const token = params.get('token');
    if (!token) {
      setFailed(true);
      return;
    }
    signIn('sso', { grant: token, callbackUrl: absoluteHere('/'), redirect: true }).catch(() => setFailed(true));
  }, [params, sessionStatus]);

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
