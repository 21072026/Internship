import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getServerDictionary } from '@/i18n/server';
import { hostBrand } from '@/lib/hostBrand';
import { requestHostHeader } from '@/lib/publicHostOrg';
import { affiliateProgrammeForHost } from '@/lib/affiliatePublicPage';
import { readStoredLanding } from '@/lib/affiliateLandingRule';
import { contractTextFor } from '@/lib/affiliateContractRule';
import { interpolate } from '@/lib/notificationText';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { PartnerFooter } from '../PartnerFooter';

// The partner contract, public and read-only (#3363): the text a partner
// accepts in the portal, in its current version, so an applicant can read it
// before applying (the form records which version they accepted). Exists only
// where the host serves a programme that has a contract — a 404 otherwise.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDictionary();
  return { title: t.affiliateLanding.contractTitle };
}

export default async function PartnerTermsPage() {
  const programme = await affiliateProgrammeForHost(requestHostHeader(await headers()));
  if (!programme?.contract) notFound();
  const { t, locale } = await getServerDictionary();
  const L = t.affiliateLanding;
  const text = contractTextFor(programme.contract.texts, locale);
  if (!text) notFound();
  const brand = await hostBrand();
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <main id="main-content" className="mx-auto max-w-3xl space-y-6 px-4 py-10">
        <div className="flex items-center justify-between gap-4">
          <Link href="/partner" className="text-sm font-medium hover:underline" style={{ color: brand.themeColor }}>
            ← {L.contractBack}
          </Link>
          <LanguageSwitcher current={locale} />
        </div>
        <div className="space-y-1">
          <h1 className="text-3xl font-bold">{L.contractTitle}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="partner-contract-version">
            {interpolate(L.contractVersion, { n: String(programme.contract.version) })}
          </p>
        </div>
        <article lang={text.locale} className="whitespace-pre-line rounded-xl border border-gray-200 bg-white p-6 text-sm leading-relaxed dark:border-gray-800 dark:bg-gray-900" data-testid="partner-contract-text">
          {text.text}
        </article>
      </main>
      <PartnerFooter landing={readStoredLanding(programme.landing)} hasContract labels={L} />
    </div>
  );
}
