'use client';
import { useT, useLocale } from "@/i18n/client";
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { GraduationCap } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Suspense } from 'react';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';

const registerSchema = z
  .object({
    token: z.string().optional(),
    email: z.string().email('Invalid email address'),
    fullName: z.string().min(1, 'Full name is required'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
    consent: z.literal(true, { errorMap: () => ({ message: 'Consent is required' }) }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type RegisterData = z.infer<typeof registerSchema>;

function RegisterForm() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Record that the invitation link was opened (once), so admins see the invite
  // progress from "sent" to "link opened" before the invitee finishes signing up.
  const inviteToken = searchParams.get('token');
  useEffect(() => {
    if (!inviteToken) return;
    fetch('/api/invite/opened', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken }),
    }).catch(() => {});
  }, [inviteToken]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterData>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      token: searchParams.get('token') || '',
    },
  });

  const onSubmit = handleSubmit(async (data) => {
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: data.token,
          email: data.email,
          password: data.password,
          fullName: data.fullName,
          consent: data.consent,
          privacyVersion: PRIVACY_POLICY_VERSION,
        }),
      });

      const body = await res.json();

      if (!res.ok) {
        throw new Error(body.error || 'Registration failed');
      }

      // Token-less self-registration is created pending admin approval.
      router.push(body.pending ? '/auth/signin?pending=true' : '/auth/signin?registered=true');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
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
          <h1 className="text-3xl font-bold text-gray-900">{t.auth.createAccount}</h1>
          <p className="text-gray-500 mt-2">{t.auth.registerSubtitle}</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4">
            <Input
              label={t.auth.invitationToken}
              hint={t.auth.tokenHint}
              placeholder={t.auth.tokenPlaceholder}
              {...register('token')}
              error={errors.token?.message}
            />
            <Input
              label={t.auth.fullName}
              required
              autoComplete="name"
              {...register('fullName')}
              error={errors.fullName?.message}
            />
            <Input
              label={t.auth.email}
              type="email"
              required
              autoComplete="email"
              hint={t.auth.emailMatchHint}
              {...register('email')}
              error={errors.email?.message}
            />
            <Input
              label={t.auth.password}
              type="password"
              required
              autoComplete="new-password"
              {...register('password')}
              error={errors.password?.message}
            />
            <Input
              label={t.auth.confirmPassword}
              type="password"
              required
              autoComplete="new-password"
              {...register('confirmPassword')}
              error={errors.confirmPassword?.message}
            />
            <div className="rounded-lg bg-blue-50 border border-blue-100 p-3 text-xs text-gray-600">
              <p className="font-medium text-gray-700 mb-1">{t.auth.dataSharingTitle}</p>
              <p>{t.auth.dataSharingBody}</p>
            </div>
            <label className="flex items-start gap-2 text-xs text-gray-600">
              <input type="checkbox" className="mt-0.5" {...register('consent')} />
              <span>
                {t.auth.consentNote}{' '}
                <Link href="/privacy" className="text-blue-600 hover:underline">{t.auth.privacyLink}</Link>
                {' '}&{' '}
                <Link href="/terms" className="text-blue-600 hover:underline">{t.auth.termsLink}</Link>
              </span>
            </label>
            {errors.consent && <p className="text-xs text-red-600">{t.auth.consentRequired}</p>}
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              {t.auth.createAccount}
            </Button>
          </form>

          <p className="text-center text-sm text-gray-500 mt-6">
            {t.auth.alreadyAccount}{' '}
            <Link href="/auth/signin" className="text-blue-600 hover:underline font-medium">
              {t.auth.signinLink}
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

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <RegisterForm />
    </Suspense>
  );
}
