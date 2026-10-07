'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BrandTile } from '@/components/BrandMark';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useT, useLocale } from '@/i18n/client';

// "E-mail me a sign-in link" (#1959). The same shape as /auth/forgot: one
// field, one POST, and a confirmation that says the same thing whether or not
// the address has an account — the endpoint answers 200 either way, and this
// page must not add a tell of its own (a different message, a different page)
// for the known case. It lands on /auth/magic/sent unconditionally.
export default function MagicLinkRequestPage() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch {
      // A network failure is still "check your inbox": the page has no way to
      // know more, and saying so would only differ for one class of visitor.
    }
    router.replace('/auth/magic/sent');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-3">
            <BrandTile />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">{t.auth.magicTitle}</h1>
          <p className="text-gray-500 mt-2">{t.auth.magicSubtitle}</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <form method="post" onSubmit={onSubmit} className="space-y-4" data-testid="magic-link-form">
            <Input
              label={t.auth.email}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              {t.auth.magicSubmit}
            </Button>
          </form>

          <div className="flex items-center justify-center gap-4 mt-6">
            <Link href="/auth/signin" className="text-sm text-blue-600 hover:underline font-medium">
              {t.auth.backToSignin}
            </Link>
            <LanguageSwitcher current={locale} />
          </div>
        </div>
      </div>
    </div>
  );
}
