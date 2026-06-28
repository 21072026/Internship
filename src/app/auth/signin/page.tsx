'use client';
import { useT } from "@/i18n/client";

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
import { roleHome } from '@/lib/roleHome';

const signinSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

type SignInData = z.infer<typeof signinSchema>;

export default function SignInPage() {
  const t = useT();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Already signed in → go straight to the role dashboard.
  useEffect(() => {
    if (status === 'authenticated') {
      router.replace(roleHome(session?.user?.role));
    }
  }, [status, session, router]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignInData>({
    resolver: zodResolver(signinSchema),
  });

  const onSubmit = handleSubmit(async (data) => {
    setLoading(true);
    setError('');

    const result = await signIn('credentials', {
      redirect: false,
      email: data.email,
      password: data.password,
    });

    if (result?.error) {
      setError(result.error || 'Sign in failed');
      setLoading(false);
      return;
    }

    const res = await fetch('/api/auth/session');
    const fresh = await res.json();
    router.push(roleHome(fresh?.user?.role));
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
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
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
            Have an invitation?{' '}
            <Link href="/auth/register" className="text-blue-600 hover:underline font-medium">
              Register here
            </Link>
          </p>
        </div>

        <p className="text-center text-sm text-gray-400 mt-6">
          <Link href="/" className="hover:text-gray-600">
            ← Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
