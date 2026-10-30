import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getServerDictionary } from '@/i18n/server';
import { hostBrand } from '@/lib/hostBrand';
import { requestHostHeader } from '@/lib/publicHostOrg';
import { affiliateProgrammeForHost } from '@/lib/affiliatePublicPage';
import { ApplicationForm } from './ApplicationForm';

// The public partner application (docs/affiliate-module.md, #3361): what the
// "become a partner" buttons of /partner open. Exists wherever the host serves a
// programme (the same rule as the API route), so the form is never shown where
// its POST would answer 503.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDictionary();
  return { title: t.affiliateApply.title };
}

export default async function PartnerApplyPage() {
  const programme = await affiliateProgrammeForHost(requestHostHeader(await headers()));
  if (!programme) notFound();
  const { t } = await getServerDictionary();
  const brand = await hostBrand();
  return (
    <div className="min-h-screen bg-gray-50 px-4 py-10 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <main id="main-content" className="mx-auto max-w-xl space-y-6">
        <Link href="/partner" className="text-sm font-medium hover:underline" style={{ color: brand.themeColor }}>
          ← {t.affiliateApply.back}
        </Link>
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">{t.affiliateApply.title}</h1>
          <p className="text-gray-600 dark:text-gray-400">{t.affiliateApply.intro}</p>
        </div>
        <ApplicationForm accent={brand.themeColor} />
      </main>
    </div>
  );
}
