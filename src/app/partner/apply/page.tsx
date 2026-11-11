import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getServerDictionary } from '@/i18n/server';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { hostBrand } from '@/lib/hostBrand';
import { requestHostHeader } from '@/lib/publicHostOrg';
import { affiliateProgrammeForHost } from '@/lib/affiliatePublicPage';
import { legalLinks, readStoredLanding, themePalette, onFill, CONTRAST_TEXT } from '@/lib/affiliateLandingRule';
import { themeMediaFor } from '@/lib/affiliateLandingAssets';
import { themeFontFamily } from '@/lib/partnerThemeFonts';
import { ApplicationForm } from './ApplicationForm';
import { PartnerFooter } from '../PartnerFooter';

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
  const { t, locale } = await getServerDictionary();
  const brand = await hostBrand();
  const landing = readStoredLanding(programme.landing);
  // The programme's own look (#3535), when it has one: its fonts, logo and main
  // colour. Its page and text colours apply in light mode only — the form's
  // fields are the app's own and follow dark mode, so a dark page keeps them
  // readable rather than painting light-on-light.
  const theme = landing.theme;
  const p = theme ? themePalette(theme) : null;
  const logo = theme ? (await themeMediaFor(programme.orgId, theme)).logo : undefined;
  const accent = p ? p.primary : brand.themeColor;
  return (
    <div
      className={`min-h-screen px-4 py-10 dark:bg-gray-950 dark:text-gray-100 ${p ? 'bg-[var(--pt-bg)] text-[color:var(--pt-text)]' : 'bg-gray-50 text-gray-900'}`}
      style={
        theme && p
          ? ({ '--pt-bg': p.background, '--pt-text': p.text, fontFamily: themeFontFamily(theme.bodyFont) } as React.CSSProperties)
          : undefined
      }
      data-theme={theme ? 'custom' : undefined}
    >
      <main id="main-content" className="mx-auto max-w-xl space-y-6">
        <div className="flex items-center justify-between gap-4">
          <Link href="/partner" className={`text-sm font-medium hover:underline ${p ? 'dark:!text-gray-200' : ''}`} style={{ color: p ? p.accentText : brand.themeColor }}>
            ← {t.affiliateApply.back}
          </Link>
          <LanguageSwitcher current={locale} />
        </div>
        {logo && p && (
          // On the programme page's own gradient: a logo made for the hero (often white) stays visible here.
          <Link href="/partner" className="inline-block rounded-lg px-4 py-3" style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.secondary})` }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- an upload served by our own route */}
            <img src={logo.url} alt={brand.productName} className="h-10 w-auto max-w-[220px] object-contain" data-testid="partner-logo" />
          </Link>
        )}
        <div className="space-y-2">
          <h1 className="text-3xl font-bold" style={theme ? { fontFamily: themeFontFamily(theme.headingFont) } : undefined}>{t.affiliateApply.title}</h1>
          <p className={p ? 'dark:text-gray-400' : 'text-gray-600 dark:text-gray-400'}>{t.affiliateApply.intro}</p>
        </div>
        <ApplicationForm
          accent={accent}
          ink={p ? (onFill([p.primary], CONTRAST_TEXT) ?? undefined) : undefined}
          privacy={legalLinks(landing).privacyUrl}
          contractVersion={programme.contract?.version ?? null}
        />
      </main>
      <div className="mt-10">
        <PartnerFooter landing={landing} hasContract={programme.contract !== null} labels={t.affiliateLanding} />
      </div>
    </div>
  );
}
