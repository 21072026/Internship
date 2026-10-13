'use client';

import Link from 'next/link';
import { BrandTile } from '@/components/BrandMark';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useT, useLocale } from '@/i18n/client';

// The confirmation after a sign-in link was requested (#1959). Static on
// purpose: it does not know — and must not know — whether a mail went out.
export default function MagicLinkSentPage() {
  const t = useT();
  const locale = useLocale();

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-3">
            <BrandTile />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">{t.auth.magicSentTitle}</h1>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm" data-testid="magic-link-sent">
            {t.auth.magicSentBody}
          </div>

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
