'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { BrandTile } from '@/components/BrandMark';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { AUTH_SSO_REQUIRED, INTENTIONAL_AUTH_ERRORS } from '@/lib/authErrors';
import { roleHome } from '@/lib/roleHome';
import { useT } from '@/i18n/client';

// The page a sign-in link opens (#1959). It redeems the link through the
// `magic` NextAuth provider — mirroring /auth/sso/complete, with one more
// state: an account with 2FA enrolled is answered `2FA_REQUIRED` on the first
// attempt (the link is NOT spent by that answer), the page asks for the code
// and sends the link again with it. The link is spent only when the provider
// has accepted the code.
type Stage = 'redeeming' | 'totp' | 'failed';

function Complete() {
  const params = useSearchParams();
  const t = useT();
  const [stage, setStage] = useState<Stage>('redeeming');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Redeemed exactly once per visit (#2548): React StrictMode re-runs the
  // effect in dev, and a second redemption of a single-use link is the loser's
  // navigation aborting the winner's — see /auth/sso/complete.
  const started = useRef(false);

  const redeem = async (totp: string) => {
    const token = params.get('token');
    if (!token) {
      setStage('failed');
      return;
    }
    setBusy(true);
    setError('');
    const result = await signIn('magic', { grant: token, totp, redirect: false }).catch(() => null);
    if (!result || result.error) {
      const err = result?.error ?? '';
      if (err === '2FA_REQUIRED') {
        setStage('totp');
      } else if (stage === 'totp' && err !== AUTH_SSO_REQUIRED && INTENTIONAL_AUTH_ERRORS.has(err)) {
        // A wrong or replayed code, or a locked bucket: the link is still live,
        // so stay on the code prompt and say what the password form would say.
        setError(err);
      } else {
        // A spent or expired link, a refused account state, or anything the
        // server did not say on purpose: never render it (#1150) — the honest
        // advice in every one of those cases is "request a new link".
        setStage('failed');
      }
      setBusy(false);
      return;
    }
    // Same settle-then-full-navigation as the sign-in form: a strict-cookie
    // browser may not have committed the session cookie yet.
    let role: string | undefined;
    for (let i = 0; i < 6; i++) {
      const res = await fetch('/api/auth/session', { cache: 'no-store' });
      const fresh = await res.json().catch(() => null);
      role = fresh?.user?.role;
      if (role) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    window.location.assign(roleHome(role));
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void redeem('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    await redeem(code.trim());
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-3">
            <BrandTile />
          </div>
          {stage === 'totp' && (
            <>
              <h1 className="text-3xl font-bold text-gray-900">{t.auth.magicTwoFactorTitle}</h1>
              <p className="text-gray-500 mt-2">{t.auth.magicTwoFactorBody}</p>
            </>
          )}
          {stage === 'failed' && (
            <>
              <h1 className="text-3xl font-bold text-gray-900">{t.auth.magicFailedTitle}</h1>
              <p className="text-gray-500 mt-2">{t.auth.magicFailedBody}</p>
            </>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          {stage === 'redeeming' && (
            <p className="text-center text-gray-600" data-testid="magic-link-redeeming">{t.auth.magicSigningIn}</p>
          )}
          {stage === 'totp' && (
            <form onSubmit={submitCode} className="space-y-4" data-testid="magic-link-totp-form">
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm" role="alert">
                  {error}
                </div>
              )}
              <Input
                label={t.auth.twoFactorCode}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">{t.auth.twoFactorRecoveryHint}</p>
              <Button type="submit" className="w-full" size="lg" loading={busy}>
                {t.auth.magicTwoFactorSubmit}
              </Button>
            </form>
          )}
          {stage === 'failed' && (
            <div className="text-center" data-testid="magic-link-failed">
              <Link href="/auth/magic" className="text-blue-600 hover:underline font-medium">
                {t.auth.magicRequestAgain}
              </Link>
            </div>
          )}

          <div className="flex items-center justify-center gap-4 mt-6">
            <Link href="/auth/signin" className="text-sm text-blue-600 hover:underline font-medium">
              {t.auth.backToSignin}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MagicLinkCompletePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
          <p className="text-gray-600 dark:text-gray-300">…</p>
        </div>
      }
    >
      <Complete />
    </Suspense>
  );
}
