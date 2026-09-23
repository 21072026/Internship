import type { Metadata } from 'next';
import Link from 'next/link';
import {
  BadgeEuro, Building2, CheckCircle, GraduationCap, Info, Scale, Server, Sparkles, TrendingUp, UserPlus, Users,
} from 'lucide-react';
import { getServerDictionary, resolveRequestVertical } from '@/i18n/server';
import { productNameFor } from '@/lib/verticals';
import { PublicShell } from '@/components/landing/PublicShell';
import {
  ADDONS,
  EDUCATION_DISCOUNT_RATE,
  OVERAGE_SHARE,
  PLACEMENT_FEE_BOOKABLE,
  PLACEMENT_FEE_EUR,
  NEVER_METERED,
  SELF_SERVE_CHECKOUT,
  annualMonthlyEur,
  annualMonthsFree,
  annualSavingEur,
  overagePerPairCents,
  plansForAudience,
  type Addon,
  type Plan,
} from '@/lib/plans';
import { formatCount, formatDecimal, formatEur, formatEurCents, formatPercent } from '@/lib/money';

export const dynamic = 'force-dynamic';

// Localized, unlike the other public pages' static `metadata`: this is a
// marketing page in three languages, and a German visitor arriving from search
// should not get an English browser tab and an English snippet. `getServerDictionary`
// reads the locale cookie, which is legal here because the page is
// force-dynamic anyway.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDictionary();
  // The product name is the VERTICAL's, not a literal (#2475): a marketing
  // host's tab said "Pricing — InternshipCRM" while every other public page had
  // already moved to the vertical wordmark (#2498). `heroSubtitle` is overlaid
  // for MARKETING, so the search snippet says "not published yet" rather than
  // describing the matched-pair meter.
  const productName = productNameFor(await resolveRequestVertical());
  return { title: `${t.pricing.metaTitle} — ${productName}`, description: t.pricing.heroSubtitle };
}

/**
 * The page that ends the comparison (#1730, story #1726).
 *
 * Everything numeric on it comes from `src/lib/plans.ts` and is rendered
 * through `src/lib/money.ts`: grep this file for a currency symbol and you
 * find none, which is an acceptance criterion rather than a style preference.
 * A price typed into a JSX string here is a price that disagrees with the
 * invoice the moment packaging changes, and the pricing page is the one place
 * that disagreement is public.
 *
 * The order of sections is deliberate and answers the four questions a
 * programme owner arrives with, in the order they ask them: what is free, what
 * does the paid tier cost, what exactly gets counted, and what happens if we
 * grow. The employer wallet comes after all of that, because it is a different
 * buyer and mixing the two is what made the old pilot copy unreadable.
 *
 * Dark mode needs no new rule: every tinted panel here is a `bg-*-50` in a
 * color `globals.css` already retints (green / blue / indigo / amber / purple),
 * and its mid-tone `text-*-700` descendants are covered by the existing
 * compound overrides. No `bg-*-100` chip carries accent text, which is the
 * case those overrides deliberately leave alone.
 */
export default async function PricingPage() {
  const { locale, t } = await getServerDictionary();
  const p = t.pricing;

  const eur = (amount: number) => formatEur(amount, locale);
  const pct = (share: number) => formatPercent(share, locale);
  const count = (value: number | null) => formatCount(value, locale, p.unlimited);

  // Which product's price is this (#2475)? Every number on this page comes from
  // `src/lib/plans.ts`, and every one of them prices the INTERNSHIP product: the
  // metering unit is the active matched pair, the free core is "free for mentees
  // and mentors", the second wallet is a company hiring an intern. None of that
  // is a statement anyone has made about the marketing product — its packaging
  // has not been decided — so a MARKETING host does not get those sections
  // re-worded, it does not get them at all. Inventing a marketing price here
  // would be the one kind of wrong this page cannot afford: it is the page that
  // makes the pricing public.
  //
  // What survives is what is true whatever the packaging turns out to be:
  // self-hosting is free (AGPL-3.0), and there is no checkout — a paid plan is
  // invoiced after a conversation. Same resolution as the landing: session
  // first, request host second.
  const isMarketing = (await resolveRequestVertical()) === 'MARKETING';

  // Published discounts are discounts ON PLANS. With no marketing plans, the
  // annual and education lines would be discounts off nothing; the self-host
  // line is a licence fact and holds for every vertical.
  const discounts = isMarketing
    ? [{ icon: Server, text: p.discountSelfHost }]
    : [
        { icon: TrendingUp, text: p.discountAnnual },
        { icon: GraduationCap, text: p.discountEducation.replace('{pct}', pct(EDUCATION_DISCOUNT_RATE)) },
        { icon: Server, text: p.discountSelfHost },
      ];

  // Four of the six questions are about the internship meter (pairs, mentors,
  // the education discount). The two that are not — can we self-host, how do we
  // actually pay — are the two a marketing visitor is most likely to have.
  const faqs = isMarketing
    ? [
        { q: p.faq5Q, a: p.faq5A },
        { q: p.faq6Q, a: p.faq6A },
      ]
    : [
        { q: p.faq1Q, a: p.faq1A },
        { q: p.faq2Q, a: p.faq2A },
        { q: p.faq3Q, a: p.faq3A },
        { q: p.faq4Q, a: p.faq4A.replace('{pct}', pct(EDUCATION_DISCOUNT_RATE)) },
        { q: p.faq5Q, a: p.faq5A },
        { q: p.faq6Q, a: p.faq6A },
      ];

  const programPlans = plansForAudience('PROGRAM');
  const employerPlans = plansForAudience('EMPLOYER');

  return (
    <PublicShell>
      <div className="max-w-6xl mx-auto px-4 py-12 sm:py-16">
        {/* Hero */}
        <div className="text-center max-w-3xl mx-auto">
          <span className="inline-flex items-center gap-2 bg-indigo-100 text-indigo-700 px-4 py-2 rounded-full text-sm font-medium mb-6">
            <BadgeEuro className="h-4 w-4" />
            {p.heroBadge}
          </span>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 leading-tight">{p.heroTitle}</h1>
          <p className="text-lg text-gray-600 mt-4 leading-relaxed">{p.heroSubtitle}</p>
        </div>

        {/* Everything from here to the discounts states the INTERNSHIP price
            model — the free core, the plan bands, the meter, the overage, the
            employer wallet and the add-ons all come from src/lib/plans.ts. A
            MARKETING host renders none of it (#2475); see the note on
            `isMarketing` above for why it is hidden rather than re-worded. */}
        {!isMarketing && (<>
        {/* Free core, at the very top: the promise is the product, not a
            footnote under the cheapest column. */}
        <section
          className="mt-12 rounded-2xl bg-green-50 border border-green-200 p-6 sm:p-8"
          data-testid="pricing-free-core"
        >
          <div className="max-w-3xl">
            <h2 className="inline-flex items-center gap-2 text-xl sm:text-2xl font-bold text-green-900">
              <CheckCircle className="h-6 w-6 text-green-600 flex-shrink-0" />
              {p.freeTitle}
            </h2>
            <p className="mt-3 text-green-800 leading-relaxed">{p.freeBody}</p>
          </div>
          <h3 className="mt-7 text-sm font-semibold uppercase tracking-wide text-green-700">
            {p.neverMeteredTitle}
          </h3>
          {/* Rendered from NEVER_METERED rather than a hand-written list: the
              free-core rule and the list a visitor reads are then the same
              object, and one cannot lose an entry the other keeps. */}
          <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2" data-testid="never-metered">
            {NEVER_METERED.map((cap) => (
              <li key={cap} className="flex items-start gap-2 text-sm text-green-800">
                <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0 mt-0.5" />
                {p.neverMetered[cap]}
              </li>
            ))}
          </ul>
        </section>

        {/* Programme-side plans */}
        <section className="mt-16" data-testid="pricing-program-plans">
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">{p.plansTitle}</h2>
            <p className="mt-3 text-gray-600">{p.plansSubtitle}</p>
          </div>
          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
            {programPlans.map((plan) => (
              <PlanCard key={plan.key} plan={plan} p={p} eur={eur} count={count} locale={locale} />
            ))}
          </div>
          <p className="mt-6 text-center text-sm text-gray-500">{p.vatNote}</p>
        </section>

        {/* How we count — the section that makes the free-core promise
            checkable instead of merely stated. */}
        <section className="mt-16 rounded-2xl bg-blue-50 border border-blue-200 p-6 sm:p-8" data-testid="pricing-metering">
          <h2 className="inline-flex items-center gap-2 text-2xl font-bold text-blue-900">
            <Info className="h-6 w-6 text-blue-600 flex-shrink-0" />
            {p.meteringTitle}
          </h2>
          <p className="mt-3 text-blue-800">{p.meteringLead}</p>
          <ul className="mt-4 space-y-2.5 max-w-3xl">
            {[p.meteringCounted, p.meteringNotCounted, p.meteringNeverCounted, p.meteringNeverPerProgram].map((rule) => (
              <li key={rule} className="flex items-start gap-2.5 text-blue-800 leading-relaxed">
                <span aria-hidden className="mt-2 h-1.5 w-1.5 rounded-full bg-blue-600 flex-shrink-0" />
                {rule}
              </li>
            ))}
          </ul>
        </section>

        {/* Over the band */}
        <section className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-5" data-testid="pricing-overage">
          {programPlans
            .filter((plan) => overagePerPairCents(plan.key) != null)
            .map((plan) => {
              const cents = overagePerPairCents(plan.key) as number;
              return (
                <div key={plan.key} className="rounded-2xl border border-gray-200 bg-white p-6">
                  <h3 className="inline-flex items-center gap-2 font-semibold text-gray-900">
                    <TrendingUp className="h-5 w-5 text-indigo-600 flex-shrink-0" />
                    {plan.name} · {p.overageTitle}
                  </h3>
                  <p className="mt-2 text-lg font-bold text-gray-900">
                    {p.overageBody.replace('{rate}', formatEurCents(cents, locale))}
                  </p>
                  {/* The rule, not just the number: OVERAGE_SHARE is what the
                      rate is derived from, so the sentence stays true if a
                      plan price moves. */}
                  <p className="mt-2 text-sm text-gray-600 leading-relaxed">
                    {p.overageRule.replace('{pct}', pct(OVERAGE_SHARE))}
                  </p>
                  <p className="mt-2 text-sm text-gray-600 leading-relaxed">{p.overageChoice}</p>
                </div>
              );
            })}
          <div className="rounded-2xl bg-amber-50 border border-amber-200 p-6">
            <h3 className="font-semibold text-amber-900">{p.overageNoneTitle}</h3>
            <p className="mt-2 text-sm text-amber-800 leading-relaxed">{p.overageNoneFree}</p>
          </div>
        </section>

        {/* Employer wallet — a different buyer, kept visibly separate. */}
        <section className="mt-16" data-testid="pricing-employer">
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="inline-flex items-center gap-2 text-2xl sm:text-3xl font-bold text-gray-900">
              <Building2 className="h-7 w-7 text-purple-600 flex-shrink-0" />
              {p.employerTitle}
            </h2>
            <p className="mt-3 text-gray-600">{p.employerSubtitle}</p>
          </div>
          <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-5">
            {employerPlans.map((plan) => (
              <PlanCard key={plan.key} plan={plan} p={p} eur={eur} count={count} locale={locale} />
            ))}
          </div>

          <div className="mt-6 rounded-2xl bg-purple-50 border border-purple-200 p-6" data-testid="pricing-placement-fee">
            <h3 className="font-semibold text-purple-900">{p.placementTitle}</h3>
            <p className="mt-2 text-purple-800">
              {p.placementBody.replace('{amount}', eur(PLACEMENT_FEE_EUR))}
            </p>
            {/* The footnote is conditional on the flag, not hardcoded, so it
                disappears by itself the day the legal check clears rather than
                being one more thing to remember to delete. */}
            {!PLACEMENT_FEE_BOOKABLE && (
              <p className="mt-3 flex items-start gap-2 text-sm text-purple-800 leading-relaxed">
                <Scale className="h-4 w-4 text-purple-600 flex-shrink-0 mt-0.5" />
                {p.placementLegalNote}
              </p>
            )}
          </div>
        </section>

        {/* Add-ons */}
        <section className="mt-16" data-testid="pricing-addons">
          <h2 className="text-2xl font-bold text-gray-900 text-center">{p.addonsTitle}</h2>
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-5">
            {ADDONS.map((addon) => (
              <div key={addon.key} className="rounded-xl border border-gray-200 bg-white p-6">
                <div className="flex items-start justify-between gap-4">
                  <h3 className="font-semibold text-gray-900">{p.addon[addon.key].t}</h3>
                  <span className="text-sm font-semibold text-gray-900 whitespace-nowrap">
                    {addonPrice(addon, p, eur)}
                  </span>
                </div>
                <p className="mt-2 text-sm text-gray-600 leading-relaxed">{p.addon[addon.key].d}</p>
              </div>
            ))}
          </div>
        </section>

        </>)}

        {/* Published discounts. On a marketing host this is the one section that
            survives, holding the single claim that needs no price list: the app
            is AGPL-3.0, so running it yourself is free. Its heading is overlaid
            to "What is already true" there — one card in a three-column grid
            would otherwise sit in a third of the page. */}
        <section className="mt-16" data-testid="pricing-discounts">
          <h2 className="text-2xl font-bold text-gray-900 text-center">{p.discountsTitle}</h2>
          <div className={`mt-8 grid grid-cols-1 gap-5 ${discounts.length > 1 ? 'md:grid-cols-3' : 'max-w-2xl mx-auto'}`}>
            {discounts.map((d) => (
              <div key={d.text} className="flex items-start gap-3 p-6 rounded-xl border border-gray-200 bg-white">
                <d.icon className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-gray-600 leading-relaxed">{d.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="mt-16 max-w-3xl mx-auto" data-testid="pricing-faq">
          <h2 className="text-2xl font-bold text-gray-900 text-center mb-8">{p.faqTitle}</h2>
          <dl className="space-y-5">
            {faqs.map((item) => (
              <div key={item.q} className="p-6 rounded-xl border border-gray-200 bg-white">
                <dt className="font-semibold text-gray-900">{item.q}</dt>
                <dd className="mt-2 text-gray-600 leading-relaxed">{item.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Per-audience CTAs. All four doors are internship ones — the partner
            company, the programme owner, the mentee sign-up and the mentor
            application — and two of them point at routes a marketing host
            deliberately does not serve, so the whole section is left out there
            (#2475). A marketing host has no public contact route yet; inventing
            one here would be the same mistake as inventing a price. */}
        {!isMarketing && (
        <section className="mt-16" data-testid="pricing-cta">
          <h2 className="text-2xl font-bold text-gray-900 text-center mb-8">{p.ctaTitle}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
            {[
              { icon: Building2, t: p.ctaEmployerT, d: p.ctaEmployerD, a: p.ctaEmployerA, href: '/for-companies#talk' },
              { icon: Users, t: p.ctaInstitutionT, d: p.ctaInstitutionD, a: p.ctaInstitutionA, href: '/for-companies#talk' },
              { icon: UserPlus, t: p.ctaMenteeT, d: p.ctaMenteeD, a: p.ctaMenteeA, href: '/auth/register' },
              { icon: GraduationCap, t: p.ctaMentorT, d: p.ctaMentorD, a: p.ctaMentorA, href: '/apply-as-mentor' },
            ].map((c) => (
              <div key={c.t} className="flex flex-col p-6 rounded-xl border border-gray-200 bg-white">
                <c.icon className="h-6 w-6 text-blue-600" />
                <h3 className="mt-3 font-semibold text-gray-900">{c.t}</h3>
                <p className="mt-1 text-sm text-gray-600 leading-relaxed flex-1">{c.d}</p>
                <Link
                  href={c.href}
                  className="mt-4 inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  {c.a}
                </Link>
              </div>
            ))}
          </div>
        </section>
        )}

        {/* How you actually pay. Conditional on the flag for the same reason
            the placement footnote is: when checkout ships, this note is wrong,
            and a note that removes itself cannot be forgotten. */}
        {!SELF_SERVE_CHECKOUT && (
          <p className="mt-12 mx-auto max-w-3xl text-center text-sm text-gray-500 leading-relaxed" data-testid="pricing-no-checkout">
            {p.noCheckoutNote}
          </p>
        )}

        <div className="mt-10 text-center">
          <Link href="/" className="text-sm text-gray-400 hover:text-gray-600">{p.backHome}</Link>
        </div>
      </div>
    </PublicShell>
  );
}

type PricingCopy = Awaited<ReturnType<typeof getServerDictionary>>['t']['pricing'];
type Loc = Awaited<ReturnType<typeof getServerDictionary>>['locale'];

/** The price line of an add-on. INCLUDED prints a promise, not a zero. */
function addonPrice(addon: Addon, p: PricingCopy, eur: (n: number) => string): string {
  if (addon.billing === 'INCLUDED') return p.addonIncluded;
  const template = addon.billing === 'ONE_OFF' ? p.addonOneOff : p.addonPerMonth;
  return template.replace('{amount}', eur(addon.priceEur));
}

/**
 * One plan column, for either wallet.
 *
 * The two audiences get different limit rows on purpose. An employer plan
 * carries `activePairs: 0` and `programs: 0` — which `plans.ts` documents as
 * "this meter does not apply here", not as a limit of zero — so printing those
 * rows would tell a hiring company it may run no programmes, which is true but
 * meaningless, and that it gets no mentoring pairs, which reads as a downgrade
 * of something it never buys. Same reason `monthlyBroadcastRecipients` is
 * labelled as candidate messages on that side: it is the same column meaning
 * a different thing.
 */
function PlanCard({
  plan, p, eur, count, locale,
}: {
  plan: Plan;
  p: PricingCopy;
  eur: (n: number) => string;
  count: (v: number | null) => string;
  locale: Loc;
}) {
  const monthlyEquivalent = annualMonthlyEur(plan.key);
  const isFree = plan.prices.YEARLY === 0 && plan.prices.MONTHLY === 0;
  const saving = annualSavingEur(plan.key);
  const months = annualMonthsFree(plan.key);
  const isProgram = plan.audience === 'PROGRAM';

  const rows: { label: string; value: string }[] = isProgram
    ? [
        { label: p.activePairs, value: count(plan.limits.activePairs) },
        { label: p.adminSeats, value: count(plan.limits.adminSeats) },
        { label: p.programsLimit, value: count(plan.limits.programs) },
        { label: p.companiesLimit, value: count(plan.limits.companies) },
        { label: p.broadcastLimit, value: count(plan.limits.monthlyBroadcastRecipients) },
      ]
    : [
        { label: p.adminSeats, value: count(plan.limits.adminSeats) },
        { label: p.candidateMessages, value: count(plan.limits.monthlyBroadcastRecipients) },
      ];

  return (
    <div className="flex flex-col rounded-2xl border border-gray-200 bg-white p-6" data-testid={`plan-${plan.key}`}>
      <h3 className="text-lg font-bold text-gray-900">{plan.name}</h3>
      <p className="mt-1.5 text-sm text-gray-600 leading-relaxed min-h-[3.5rem]">{p.planDesc[plan.key]}</p>

      {/* Price */}
      <div className="mt-4 pb-4 border-b border-gray-100">
        {isFree ? (
          <p className="text-3xl font-bold text-gray-900">{p.free}</p>
        ) : (
          <>
            <p className="text-3xl font-bold text-gray-900">
              {/* Safe: every plan in PLANS carries a YEARLY price, so the only
                  null case is already handled by the isFree branch above. */}
              {eur(monthlyEquivalent as number)}
              <span className="text-base font-medium text-gray-500">{p.perMonth}</span>
            </p>
            <p className="mt-1 text-sm text-gray-500">
              {plan.prices.MONTHLY == null
                ? p.annualOnly
                : `${p.billedAnnually} · ${p.monthlyOption.replace('{amount}', eur(plan.prices.MONTHLY))}`}
            </p>
            {saving != null && months != null && (
              <p className="mt-2 inline-block rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700">
                {p.annualSaving
                  .replace('{amount}', eur(saving))
                  .replace('{months}', formatDecimal(months, locale))}
              </p>
            )}
          </>
        )}
      </div>

      {/* Limits */}
      <dl className="mt-4 space-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500">{row.label}</dt>
            <dd className="font-semibold text-gray-900 text-right">{row.value}</dd>
          </div>
        ))}
      </dl>

      {/* What it includes */}
      <div className="mt-5 flex-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">{p.featuresIncluded}</h4>
        {plan.features.length === 0 ? (
          <p className="mt-2 text-sm text-gray-600">{p.featuresNonePremium}</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {plan.features.map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm text-gray-600">
                <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0 mt-0.5" />
                {p.feature[f]}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Link
        href={isFree ? '/auth/register' : '/for-companies#talk'}
        className={`mt-5 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
          isFree
            ? 'border border-gray-300 text-gray-700 hover:bg-gray-50'
            : 'bg-blue-600 text-white hover:bg-blue-700'
        }`}
      >
        {isFree ? <Sparkles className="h-4 w-4" /> : null}
        {isFree ? p.planCtaFree : p.planCta}
      </Link>
    </div>
  );
}
