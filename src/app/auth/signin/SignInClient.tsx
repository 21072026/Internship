'use client';
import { useT, useLocale } from "@/i18n/client";

import { useState, useEffect } from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { GraduationCap, FlaskConical } from 'lucide-react';
import { AUTH_UNEXPECTED_ERROR } from '@/lib/authErrors';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { roleHome } from '@/lib/roleHome';

const signinSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
  totp: z.string().optional(),
});

type SignInData = z.infer<typeof signinSchema>;

// Filled in by the server page on the demo instance only; null everywhere else.
export interface DemoQuickLogin {
  accounts: { role: 'admin' | 'mentor' | 'mentee'; email: string }[];
  password: string;
}

export function SignInClient({ demo }: { demo: DemoQuickLogin | null }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [show2fa, setShow2fa] = useState(false);
  const [notice, setNotice] = useState('');
  const [needsVerify, setNeedsVerify] = useState(false);
  const [resending, setResending] = useState(false);
  const [demoLoading, setDemoLoading] = useState<string | null>(null);

  // Already signed in → go straight to the role dashboard.
  useEffect(() => {
    if (status === 'authenticated') {
      router.replace(roleHome(session?.user?.role));
    }
  }, [status, session, router]);

  // Surface a post-registration notice (pending approval / verify email).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('pending')) setNotice(t.auth.pendingApproval);
    else if (params.get('verify')) setNotice(t.auth.verifyEmailSent);
    else if (params.get('registered')) setNotice(t.auth.registeredNotice);
  }, [t]);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<SignInData>({
    resolver: zodResolver(signinSchema),
  });

  // Resend the email-verification link for a locked-out (unverified) account.
  const resendVerification = async () => {
    setResending(true);
    try {
      await fetch('/api/auth/verify-email/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: getValues('email') }),
      });
      setError('');
      setNeedsVerify(false);
      setNotice(t.auth.verificationResent);
    } finally {
      setResending(false);
    }
  };

  const onSubmit = handleSubmit(async (data) => {
    setLoading(true);
    setError('');

    const result = await signIn('credentials', {
      redirect: false,
      email: data.email,
      password: data.password,
      totp: data.totp || '',
    });

    if (result?.error) {
      // A 2FA-enabled account needs its code; reveal the field instead of an error.
      if (result.error === '2FA_REQUIRED') {
        setShow2fa(true);
        setError(t.auth.twoFactorPrompt);
      } else if (result.error === 'ACCOUNT_PENDING_APPROVAL') {
        // Waiting on a human, not on the user — don't offer the resend link.
        setError(t.auth.pendingApproval);
      } else if (result.error === 'EMAIL_NOT_VERIFIED') {
        // Offer to resend the verification link rather than a dead-end error.
        setNeedsVerify(true);
        setError(t.auth.emailNotVerified);
      } else if (result.error === AUTH_UNEXPECTED_ERROR) {
        // An internal fault. The real cause is in the server log, not here (#1150).
        setError(t.auth.signInFailed);
      } else {
        setError(result.error || t.auth.signInFailed);
      }
      setLoading(false);
      return;
    }

    await settleAndRedirect();
  });

  // Safari (and other strict-cookie browsers) can lag applying the Set-Cookie
  // that signIn() just issued, so an immediate /api/auth/session read returned
  // no user → we redirected to the default (/portal) or bounced back to
  // sign-in, i.e. an apparent "login does nothing / page repeats" loop. Poll
  // briefly for the session to settle, then do a FULL-PAGE navigation so the
  // freshly-committed cookie is guaranteed to accompany the next request
  // (client-side router.push could run before the cookie is readable).
  const settleAndRedirect = async () => {
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

  // One-click sign-in with a shared demo account (#966). The credentials are
  // the ones advertised on /demo — synthetic and public by design.
  const demoSignIn = async (email: string) => {
    if (!demo) return;
    setDemoLoading(email);
    setError('');
    const result = await signIn('credentials', {
      redirect: false,
      email,
      password: demo.password,
      totp: '',
    });
    if (result?.error) {
      // Shared demo accounts have no 2FA/verification states — any error here
      // is unexpected (e.g. mid-reset), so the generic message is honest.
      setError(t.auth.signInFailed);
      setDemoLoading(null);
      return;
    }
    await settleAndRedirect();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-3">
            <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center">
              <GraduationCap className="h-8 w-8 text-white" />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-gray-900">{t.auth.welcomeBack}</h1>
          <p className="text-gray-500 mt-2">{t.auth.signinSubtitle}</p>
        </div>

        {demo && (
          <div
            data-testid="demo-quick-login"
            className="mb-4 bg-amber-50 border border-amber-200 rounded-2xl p-5"
          >
            <p className="flex items-center gap-2 font-semibold text-amber-900 text-sm">
              <FlaskConical className="h-4 w-4 flex-shrink-0" />
              {t.demo.quickTitle}
            </p>
            <p className="mt-1 text-xs text-amber-800">{t.demo.quickHint}</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {demo.accounts.map((a) => (
                <button
                  key={a.email}
                  type="button"
                  data-testid={`demo-login-${a.role}`}
                  onClick={() => demoSignIn(a.email)}
                  disabled={demoLoading !== null}
                  className="rounded-lg bg-amber-600 text-white text-sm font-semibold py-2.5 px-2 hover:bg-amber-700 transition-colors disabled:opacity-60"
                >
                  {demoLoading === a.email ? '…' : t.demo.roles[a.role]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          {notice && (
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-blue-700 text-sm">
              {notice}
            </div>
          )}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
              {needsVerify && (
                <button
                  type="button"
                  onClick={resendVerification}
                  disabled={resending}
                  className="mt-2 block font-medium text-blue-600 hover:underline disabled:opacity-50"
                >
                  {t.auth.resendVerification}
                </button>
              )}
            </div>
          )}

          <form method="post" onSubmit={onSubmit} className="space-y-4">
            <Input
              label={t.auth.email}
              type="email"
              autoComplete="email"
              required
              {...register('email')}
              error={errors.email?.message}
            />
            <Input
              label={t.auth.password}
              type="password"
              autoComplete="current-password"
              required
              {...register('password')}
              error={errors.password?.message}
            />
            {show2fa && (
              <Input
                label={t.auth.twoFactorCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                autoFocus
                {...register('totp')}
              />
            )}
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              {t.auth.signIn}
            </Button>
          </form>

          <p className="text-center text-sm mt-4">
            <Link href="/auth/forgot" className="text-blue-600 hover:underline">
              {t.auth.forgotLink}
            </Link>
            <span className="mx-2 text-gray-300">·</span>
            <Link href="/auth/sso" className="text-blue-600 hover:underline">
              {t.auth.ssoLink}
            </Link>
          </p>

          <p className="text-center text-sm text-gray-500 mt-6">
            {t.auth.haveInvite}{' '}
            <Link href="/auth/register" className="text-blue-600 hover:underline font-medium">
              {t.auth.registerHere}
            </Link>
          </p>
          <p className="text-center text-sm text-gray-500 mt-2">
            {t.auth.wantMentor}{' '}
            <Link href="/apply-as-mentor" className="text-blue-600 hover:underline font-medium" data-testid="apply-as-mentor-link">
              {t.auth.applyMentorLink}
            </Link>
          </p>
        </div>

        <div className="flex items-center justify-center gap-4 mt-6">
          <Link href="/" className="text-sm text-gray-400 hover:text-gray-600">
            {t.auth.backHome}
          </Link>
          <LanguageSwitcher current={locale} />
        </div>
      </div>
    </div>
  );
}
