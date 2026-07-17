'use client';
import { useT, useLocale } from "@/i18n/client";

import { useState, useEffect } from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { GraduationCap } from 'lucide-react';
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

export default function SignInPage() {
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
      } else if (result.error === 'EMAIL_NOT_VERIFIED') {
        // Offer to resend the verification link rather than a dead-end error.
        setNeedsVerify(true);
        setError(t.auth.emailNotVerified);
      } else {
        setError(result.error || 'Sign in failed');
      }
      setLoading(false);
      return;
    }

    // Safari (and other strict-cookie browsers) can lag applying the Set-Cookie
    // that signIn() just issued, so an immediate /api/auth/session read returned
    // no user → we redirected to the default (/portal) or bounced back to
    // sign-in, i.e. an apparent "login does nothing / page repeats" loop. Poll
    // briefly for the session to settle, then do a FULL-PAGE navigation so the
    // freshly-committed cookie is guaranteed to accompany the next request
    // (client-side router.push could run before the cookie is readable).
    let role: string | undefined;
    for (let i = 0; i < 6; i++) {
      const res = await fetch('/api/auth/session', { cache: 'no-store' });
      const fresh = await res.json().catch(() => null);
      role = fresh?.user?.role;
      if (role) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    window.location.assign(roleHome(role));
  });

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

          <form onSubmit={onSubmit} className="space-y-4">
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
          </p>

          <p className="text-center text-sm text-gray-500 mt-6">
            {t.auth.haveInvite}{' '}
            <Link href="/auth/register" className="text-blue-600 hover:underline font-medium">
              {t.auth.registerHere}
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
