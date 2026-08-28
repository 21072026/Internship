'use client';

import { useEffect, useRef } from 'react';
import { signIn } from 'next-auth/react';
import { useT } from '@/i18n/client';
import { sameOriginPath } from '@/lib/safeRedirect';

/**
 * Silent re-authentication from a remembered device (#1495).
 *
 * Middleware routes here instead of letting the request fall through to the
 * sign-in form, so the sign-in page stays what it says it is — a place to sign
 * in, deliberately, possibly as somebody else — and the "keep me signed in"
 * path is a separate, visible step that always ends in a navigation.
 *
 * Both outcomes leave this page: the requested URL on success, the sign-in form
 * (carrying the same destination) when the device is no longer trusted.
 */
export function ResumeClient() {
  const t = useT();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    // Only somewhere on this site, so a crafted ?next= cannot turn this into an
    // open redirect (see sameOriginPath — the string check it replaced was not
    // equivalent).
    const next = sameOriginPath(new URLSearchParams(window.location.search).get('next'), '/');

    (async () => {
      try {
        const res = await fetch('/api/auth/remember/refresh', { method: 'POST' });
        // 204 = no cookie after all; 401 = expired, revoked or replayed, and
        // the response has already cleared the cookies so this cannot loop.
        const grant = res.ok ? (await res.json().catch(() => null))?.grant : null;
        if (!grant) throw new Error('no grant');
        const result = await signIn('remember', { redirect: false, grant });
        if (result?.error) throw new Error(result.error);
        // Full-page navigation: the session cookie was set on a fetch response,
        // and a client-side push could run before the browser commits it.
        window.location.assign(next);
      } catch {
        window.location.assign(`/auth/signin?callbackUrl=${encodeURIComponent(next)}`);
      }
    })();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="text-center" data-testid="remember-resuming">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        <p className="mt-4 text-sm text-gray-500">{t.auth.resumingSession}</p>
      </div>
    </div>
  );
}
