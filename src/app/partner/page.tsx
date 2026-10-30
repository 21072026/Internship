import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Phone, Mail } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { hostBrand } from '@/lib/hostBrand';
import { brandAssetPath } from '@/lib/brandRule';
import { formatMinorPrice } from '@/lib/money';
import { interpolate } from '@/lib/notificationText';
import { publicProgrammeForRequest } from '@/lib/affiliatePublicPage';
import { commissionTableRows, landingCopyFor, maxOneOffCommission, telHref } from '@/lib/affiliateLandingRule';

// The public partner-programme page (docs/affiliate-module.md, #3360): the first
// page someone who wants to become a partner sees, on the marketing host,
// signed out. Its order follows the programme pages partners already know —
// hero with three doors, introduction, commission table, four steps,
// questions, closing call to action, legal footer — but every word that is the
// organisation's own comes from its settings (#3359); this file carries only
// generic fallbacks from the dictionary. The table is built from the plan.

// The org, its copy and its plan are read per request (host + database).
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const programme = await publicProgrammeForRequest();
  const { t, locale } = await getServerDictionary();
  if (!programme) return { title: t.affiliateLanding.metaTitle, robots: { index: false, follow: false } };
  const copy = landingCopyFor(programme.landing, locale);
  return { title: copy.heroTitle ?? t.affiliateLanding.metaTitle, description: copy.intro?.slice(0, 160) };
}

const APPLY_HREF = '/partner/apply';
const PORTAL_HREF = '/auth/signin?callbackUrl=%2Faffiliate';

export default async function PartnerProgrammePage() {
  const programme = await publicProgrammeForRequest();
  if (!programme) notFound();
  const { t, locale } = await getServerDictionary();
  const L = t.affiliateLanding;
  const brand = await hostBrand();
  const copy = landingCopyFor(programme.landing, locale);
  const { plan } = programme;
  const { phone, email, productSignupUrl } = programme.landing;
  const money = (minor: number) => formatMinorPrice(minor, plan.currency, locale);
  const rows = commissionTableRows(plan);
  const accent = brand.themeColor;
  // The gradient's second stop: the same colour at 80 % when it is a plain #rrggbb.
  const accentSoft = /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}cc` : accent;
  const mark = brand.source === 'org' && brand.markVersion ? brandAssetPath(brand.markVersion, 'mark-128') : null;

  const percentLine =
    plan.percentBps > 0 && plan.switchAtCustomer !== null
      ? interpolate(L.percentRow, {
          n: String(plan.switchAtCustomer),
          p: (plan.percentBps / 100).toLocaleString(locale),
          window: plan.windowMonths !== null ? interpolate(L.percentWindow, { m: String(plan.windowMonths) }) : '',
        })
      : null;

  const heroButton = 'inline-flex items-center justify-center rounded-lg px-5 py-3 text-base font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100" data-testid="partner-page">
      <header className="text-white" style={{ background: `linear-gradient(135deg, ${accent}, ${accentSoft})` }}>
        <nav className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4" aria-label={L.navLabel}>
          <Link href="/partner" className="flex items-center gap-2 font-semibold">
            {/* eslint-disable-next-line @next/next/no-img-element -- a generated, versioned PNG served by /brand/<v>/… */}
            {mark && <img src={mark} alt="" width={32} height={32} className="h-8 w-8 rounded" />}
            <span>{brand.productName}</span>
          </Link>
          <div className="flex items-center gap-4 text-sm font-medium">
            <Link href="/partner" className="hover:underline">{L.navHome}</Link>
            <Link href={PORTAL_HREF} className="hover:underline">{L.navSignIn}</Link>
          </div>
        </nav>

        <div className="mx-auto max-w-5xl px-4 pb-16 pt-10 text-center">
          <h1 className="text-4xl font-bold leading-tight sm:text-5xl">{copy.heroTitle ?? L.heroTitle}</h1>
          {copy.heroSubtitle && <p className="mx-auto mt-4 max-w-2xl text-lg opacity-90">{copy.heroSubtitle}</p>}
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href={APPLY_HREF} className={`${heroButton} bg-white text-gray-900 hover:bg-gray-100 dark:!bg-white dark:!text-gray-900 dark:hover:!bg-gray-100`} data-testid="partner-apply">
              {copy.applyLabel ?? L.applyLabel}
            </Link>
            <Link href={PORTAL_HREF} className={`${heroButton} border-2 border-white/80 hover:bg-white/10`} data-testid="partner-portal">
              {copy.portalLabel ?? L.portalLabel}
            </Link>
            {productSignupUrl && (
              <a href={productSignupUrl} rel="noopener" className={`${heroButton} border-2 border-white/80 hover:bg-white/10`} data-testid="partner-product-signup">
                {copy.productSignupLabel ?? L.productSignupLabel}
              </a>
            )}
          </div>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-5xl space-y-16 px-4 py-14">
        {copy.intro && <p className="mx-auto max-w-3xl whitespace-pre-line text-center text-lg text-gray-700 dark:text-gray-300">{copy.intro}</p>}

        <section aria-labelledby="partner-table" className="space-y-6">
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-wide" style={{ color: accent }}>
              {interpolate(L.tableEyebrow, { amount: money(maxOneOffCommission(plan)) })}
            </p>
            <h2 id="partner-table" className="mt-1 text-3xl font-bold">{copy.tableTitle ?? L.tableTitle}</h2>
          </div>
          <div className="mx-auto max-w-2xl overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <table className="w-full text-left" data-testid="partner-commission-table">
              <thead className="bg-gray-100 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                <tr>
                  <th scope="col" className="px-5 py-3 font-semibold">{L.colPayment}</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">{L.colCommission}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="px-5 py-3">
                      {r.overMinor === null && r.upToMinor === null
                        ? L.anyPayment
                        : r.overMinor === null
                          ? interpolate(L.upTo, { amount: money(r.upToMinor as number) })
                          : r.upToMinor === null
                            ? interpolate(L.above, { amount: money(r.overMinor) })
                            : interpolate(L.range, { from: money(r.overMinor), to: money(r.upToMinor) })}
                    </td>
                    <td className="px-5 py-3 text-right font-semibold">{money(r.commissionMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {percentLine && <p className="text-center text-sm text-gray-600 dark:text-gray-400" data-testid="partner-percent">{percentLine}</p>}
          <div className="text-center">
            <Link href={APPLY_HREF} className={`${heroButton} text-white hover:opacity-90`} style={{ backgroundColor: accent }}>
              {copy.tableCtaLabel ?? L.tableCtaLabel}
            </Link>
          </div>
        </section>

        {copy.steps && copy.steps.length > 0 && (
          <section aria-labelledby="partner-steps" className="space-y-8">
            <h2 id="partner-steps" className="text-center text-3xl font-bold">{copy.stepsTitle ?? L.stepsTitle}</h2>
            <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {copy.steps.map((step, i) => (
                <li key={i} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
                  <span className="text-3xl font-bold" style={{ color: accent }} aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                  {step.title && <h3 className="mt-3 text-lg font-semibold">{step.title}</h3>}
                  {step.text && <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{step.text}</p>}
                </li>
              ))}
            </ol>
          </section>
        )}

        {phone && (
          <section aria-labelledby="partner-contact" className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <h2 id="partner-contact" className="text-2xl font-bold">{copy.contactTitle ?? L.contactTitle}</h2>
            {copy.contactText && <p className="mt-2 whitespace-pre-line text-gray-600 dark:text-gray-400">{copy.contactText}</p>}
            <a href={telHref(phone)} className={`${heroButton} mt-6 gap-2 text-white hover:opacity-90`} style={{ backgroundColor: accent }} data-testid="partner-call">
              <Phone className="h-5 w-5" aria-hidden="true" />
              {copy.callLabel ?? L.callLabel}
            </a>
          </section>
        )}

        <section aria-labelledby="partner-cta" className="rounded-2xl px-6 py-12 text-center text-white" style={{ background: `linear-gradient(135deg, ${accent}, ${accentSoft})` }}>
          <h2 id="partner-cta" className="text-3xl font-bold">{copy.ctaTitle ?? L.ctaTitle}</h2>
          {copy.ctaText && <p className="mx-auto mt-4 max-w-2xl whitespace-pre-line opacity-90">{copy.ctaText}</p>}
          {copy.bullets && copy.bullets.length > 0 && (
            <ul className="mx-auto mt-6 max-w-md space-y-1 text-left">
              {copy.bullets.map((b, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden="true">✓</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href={APPLY_HREF} className={`${heroButton} bg-white text-gray-900 hover:bg-gray-100 dark:!bg-white dark:!text-gray-900 dark:hover:!bg-gray-100`} data-testid="partner-cta-apply">
              {copy.ctaApplyLabel ?? L.ctaApplyLabel}
            </Link>
            {email && (
              <a href={`mailto:${email}`} className={`${heroButton} gap-2 border-2 border-white/80 hover:bg-white/10`} data-testid="partner-contact-mail">
                <Mail className="h-5 w-5" aria-hidden="true" />
                {copy.ctaContactLabel ?? L.ctaContactLabel}
              </a>
            )}
          </div>
        </section>
      </main>

      <footer className="border-t border-gray-200 py-8 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-400">
        <nav className="mx-auto flex max-w-5xl flex-wrap justify-center gap-6 px-4" aria-label={L.legalLabel}>
          <Link href="/imprint" className="hover:underline">{L.imprint}</Link>
          <Link href="/privacy" className="hover:underline">{L.privacy}</Link>
          <Link href="/terms" className="hover:underline">{L.terms}</Link>
        </nav>
      </footer>
    </div>
  );
}
