import Link from 'next/link';
import { Phone, Mail } from 'lucide-react';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { Reveal } from '@/components/partnerTheme/Reveal';
import { ThemeVideo } from '@/components/partnerTheme/ThemeVideo';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';
import type { Landing, LandingCopy, LandingTheme, LegalLinkKey } from '@/lib/affiliateLandingRule';
import { themeFontFamily } from '@/lib/partnerThemeFonts';
import { LARGE_BUTTON, TEXT_SHADOW, themeLook, type ThemeMedia } from '@/lib/partnerThemeLook';
import { PartnerFooter } from './PartnerFooter';

// /partner with the organisation's own look (#3535). The same sections, words,
// doors and test ids as the standard page in page.tsx — only how they look comes
// from the theme (src/lib/affiliateLandingRule.ts, src/lib/partnerThemeLook.ts),
// plus three layout choices the standard page has no room for: a band behind
// the steps, a plain closing call, and a picture or video beside it.

export interface PartnerPageView {
  L: Dictionary['affiliateLanding'];
  locale: Locale;
  copy: LandingCopy;
  productName: string;
  /** The host brand's mark, used when the theme has no logo of its own. */
  markUrl: string | null;
  phone: string | null;
  email: string | null;
  productSignupUrl: string | null;
  telHref: string | null;
  cards: { key: 'activePartners' | 'customers' | 'satisfaction'; value: string }[];
  tableEyebrow: string;
  tableRows: { label: string; commission: string }[];
  percentLine: string | null;
  applyHref: string;
  portalHref: string;
  /** The footer's legal links (#3363): the organisation's own pages, else this host's. */
  legal: Pick<Landing, LegalLinkKey>;
  /** Whether the programme has a contract, linked as /partner/terms. */
  hasContract: boolean;
}

export function ThemedPartnerPage({ view, theme, media }: { view: PartnerPageView; theme: LandingTheme; media: ThemeMedia }) {
  const { L, copy } = view;
  const look = themeLook(theme);
  const { p } = look;
  const heading = { fontFamily: themeFontFamily(theme.headingFont) };
  const hero = media.hero;
  // Over a picture or video the scrim decides the text colour; with no scrim, white with a shadow.
  const heroInk = !hero ? p.onHero : theme.heroOverlay === 'brand' ? p.onHero : '#ffffff';
  const heroShadow = hero && theme.heroOverlay === 'none' ? TEXT_SHADOW : undefined;
  const center = theme.heroAlign === 'center';
  const videoLabels = { pause: L.videoPause, play: L.videoPlay };
  const showcase = media.showcase;
  const ctaBand = theme.ctaStyle === 'band';
  const ctaInk = ctaBand ? p.onBand : p.heading;
  const ctaText = ctaBand ? p.onBand : p.text;

  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: p.background, color: p.text, fontFamily: themeFontFamily(theme.bodyFont), colorScheme: 'light' }}
      data-testid="partner-page"
      data-theme="custom"
    >
      <header
        className={`relative isolate overflow-hidden ${theme.heroHeight === 'tall' ? 'flex min-h-[85vh] flex-col' : ''}`}
        style={{ background: hero ? '#000000' : look.gradient, color: heroInk }}
        data-testid="partner-hero"
      >
        {hero?.kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element -- an upload served by our own route, not a Next image source
          <img src={hero.url} alt="" className="absolute inset-0 -z-10 h-full w-full object-cover" data-testid="partner-hero-image" />
        )}
        {hero?.kind === 'video' && <ThemeVideo src={hero.url} className="absolute inset-0 -z-10 h-full w-full object-cover" labels={videoLabels} />}
        {hero && look.overlay && <div className="absolute inset-0 -z-10" style={look.overlay} aria-hidden="true" />}

        <nav
          className={`mx-auto flex w-full max-w-5xl gap-4 px-4 py-4 ${theme.navLayout === 'center' ? 'flex-col items-center' : 'flex-wrap items-center justify-between'}`}
          aria-label={L.navLabel}
        >
          <Link href="/partner" className="flex items-center gap-2 text-lg font-bold" style={{ ...heading, ...heroShadow }}>
            {media.logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- an upload served by our own route
              <img src={media.logo.url} alt={view.productName} className="h-10 w-auto max-w-[220px] object-contain sm:h-12" data-testid="partner-logo" />
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- a generated, versioned PNG served by /brand/<v>/… */}
                {view.markUrl && <img src={view.markUrl} alt="" width={32} height={32} className="h-8 w-8 rounded" />}
                <span>{view.productName}</span>
              </>
            )}
          </Link>
          {/* On a light pill whatever the hero shows: the links stay readable on any picture. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1 text-sm font-semibold" style={{ backgroundColor: '#ffffff', color: '#111827', borderRadius: look.buttonRadius }}>
            <Link href="/partner" className="whitespace-nowrap hover:underline">{L.navHome}</Link>
            <Link href={view.portalHref} className="whitespace-nowrap hover:underline">{L.navSignIn}</Link>
            <div className="dark:!bg-white">
              <LanguageSwitcher current={view.locale} />
            </div>
          </div>
        </nav>

        <div className={`mx-auto w-full max-w-5xl px-4 pb-16 pt-10 ${center ? 'text-center' : 'text-left'} ${theme.heroHeight === 'tall' ? 'flex flex-1 flex-col justify-center' : ''}`} style={heroShadow}>
          <h1 className="text-4xl font-bold leading-tight sm:text-5xl" style={heading}>{copy.heroTitle ?? L.heroTitle}</h1>
          {copy.heroSubtitle && <p className={`mt-4 max-w-2xl text-2xl ${center ? 'mx-auto' : ''}`}>{copy.heroSubtitle}</p>}
          <div className={`mt-8 flex flex-col gap-3 sm:flex-row ${center ? 'items-center justify-center' : 'items-start'}`}>
            <Link href={view.applyHref} className={LARGE_BUTTON} style={{ ...look.button('primary'), border: `2px solid ${p.onPrimary}` }} data-testid="partner-apply">
              {copy.applyLabel ?? L.applyLabel}
            </Link>
            <Link href={view.portalHref} className={LARGE_BUTTON} style={look.outline(heroInk)} data-testid="partner-portal">
              {copy.portalLabel ?? L.portalLabel}
            </Link>
            {view.productSignupUrl && (
              <a href={view.productSignupUrl} rel="noopener" className={LARGE_BUTTON} style={{ ...look.button('secondary'), border: `2px solid ${p.onSecondary}` }} data-testid="partner-product-signup">
                {copy.productSignupLabel ?? L.productSignupLabel}
              </a>
            )}
          </div>
        </div>
      </header>

      <main id="main-content" className="space-y-16 py-14">
        {copy.intro && (
          <Reveal animation={theme.animation} className="mx-auto max-w-3xl px-4">
            <p className="whitespace-pre-line text-center text-lg">{copy.intro}</p>
          </Reveal>
        )}

        {view.cards.length > 0 && (
          <Reveal animation={theme.animation} className="mx-auto max-w-3xl px-4">
            <section aria-label={L.stats.title} data-testid="partner-stats">
              <dl className={`grid gap-4 ${view.cards.length === 1 ? 'sm:grid-cols-1' : view.cards.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
                {view.cards.map((card) => (
                  <div key={card.key} className="p-6 text-center" style={look.card} data-testid={`partner-stat-${card.key}`}>
                    <dt className="text-sm">{L.stats[card.key]}</dt>
                    <dd className="mt-1 text-3xl font-bold" style={{ ...heading, color: p.accentLarge }}>{card.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </Reveal>
        )}

        <Reveal animation={theme.animation} className="mx-auto max-w-5xl px-4">
          <section aria-labelledby="partner-table" className="space-y-6">
            <div className="text-center">
              <p className="text-sm font-semibold uppercase tracking-wide" style={{ color: p.accentText }}>{view.tableEyebrow}</p>
              <h2 id="partner-table" className="mt-1 text-3xl font-bold" style={{ ...heading, color: p.heading }}>{copy.tableTitle ?? L.tableTitle}</h2>
            </div>
            <div className="mx-auto max-w-2xl overflow-hidden" style={look.card}>
              <table className="w-full text-left" data-testid="partner-commission-table">
                <thead className="text-sm" style={{ backgroundColor: p.background, color: p.text }}>
                  <tr>
                    <th scope="col" className="px-5 py-3 font-semibold">{L.colPayment}</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">{L.colCommission}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.tableRows.map((r, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${p.text}26` }}>
                      <td className="px-5 py-3">{r.label}</td>
                      <td className="px-5 py-3 text-right font-semibold">{r.commission}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {view.percentLine && <p className="text-center text-sm" data-testid="partner-percent">{view.percentLine}</p>}
            <div className="text-center">
              <Link href={view.applyHref} className={LARGE_BUTTON} style={look.button('primary')}>
                {copy.tableCtaLabel ?? L.tableCtaLabel}
              </Link>
            </div>
          </section>
        </Reveal>

        {copy.steps && copy.steps.length > 0 && (
          <div style={theme.stepsStyle === 'band' ? { backgroundColor: p.heading } : undefined} className={theme.stepsStyle === 'band' ? 'py-14' : ''} data-testid="partner-steps">
            <Reveal animation={theme.animation} className="mx-auto max-w-5xl px-4">
              <section aria-labelledby="partner-steps" className="space-y-8">
                <h2 id="partner-steps" className="text-center text-3xl font-bold" style={{ ...heading, color: theme.stepsStyle === 'band' ? p.onHeading : p.heading }}>
                  {copy.stepsTitle ?? L.stepsTitle}
                </h2>
                <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                  {copy.steps.map((step, i) => (
                    <li key={i} className="p-6" style={look.card}>
                      <span className="text-3xl font-bold" style={{ ...heading, color: p.accentLarge }} aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                      {step.title && <h3 className="mt-3 text-xl font-bold" style={{ ...heading, color: p.heading }}>{step.title}</h3>}
                      {step.text && <p className="mt-2 text-sm">{step.text}</p>}
                    </li>
                  ))}
                </ol>
              </section>
            </Reveal>
          </div>
        )}

        {view.phone && view.telHref && (
          <Reveal animation={theme.animation} className="mx-auto max-w-5xl px-4">
            <section aria-labelledby="partner-contact" className="p-8 text-center" style={look.card}>
              <h2 id="partner-contact" className="text-2xl font-bold" style={{ ...heading, color: p.heading }}>{copy.contactTitle ?? L.contactTitle}</h2>
              {copy.contactText && <p className="mt-2 whitespace-pre-line">{copy.contactText}</p>}
              <a href={view.telHref} className={`${LARGE_BUTTON} mt-6`} style={look.button('primary')} data-testid="partner-call">
                <Phone className="h-5 w-5" aria-hidden="true" />
                {copy.callLabel ?? L.callLabel}
              </a>
            </section>
          </Reveal>
        )}

        <Reveal animation={theme.animation} className="mx-auto max-w-5xl px-4">
          <section
            aria-labelledby="partner-cta"
            className={`grid items-center gap-10 ${ctaBand ? 'px-6 py-12' : ''} ${showcase ? 'md:grid-cols-2' : 'text-center'}`}
            style={ctaBand ? { background: look.gradient, color: ctaText, borderRadius: look.cardRadius } : { color: ctaText }}
            data-testid="partner-cta"
          >
            <div className={showcase ? 'text-left' : ''}>
              <h2 id="partner-cta" className="text-3xl font-bold" style={{ ...heading, color: ctaInk }}>{copy.ctaTitle ?? L.ctaTitle}</h2>
              {copy.ctaText && <p className={`mt-4 max-w-2xl whitespace-pre-line ${showcase ? '' : 'mx-auto'}`}>{copy.ctaText}</p>}
              {copy.bullets && copy.bullets.length > 0 && (
                <ul className={`mt-6 max-w-md space-y-1 text-left ${showcase ? '' : 'mx-auto'}`}>
                  {copy.bullets.map((b, i) => (
                    <li key={i} className="flex gap-2">
                      <span aria-hidden="true">✓</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className={`mt-8 flex flex-col gap-3 sm:flex-row ${showcase ? 'items-start' : 'items-center justify-center'}`}>
                <Link href={view.applyHref} className={LARGE_BUTTON} style={ctaBand ? { ...look.button('primary'), border: `2px solid ${p.onPrimary}` } : look.button('primary')} data-testid="partner-cta-apply">
                  {copy.ctaApplyLabel ?? L.ctaApplyLabel}
                </Link>
                {view.email && (
                  <a href={`mailto:${view.email}`} className={LARGE_BUTTON} style={look.outline(ctaInk)} data-testid="partner-contact-mail">
                    <Mail className="h-5 w-5" aria-hidden="true" />
                    {copy.ctaContactLabel ?? L.ctaContactLabel}
                  </a>
                )}
              </div>
            </div>
            {showcase && (
              <div className="relative overflow-hidden" style={{ borderRadius: look.cardRadius }} data-testid="partner-showcase">
                {showcase.kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element -- an upload served by our own route
                  <img src={showcase.url} alt="" className="h-auto w-full object-cover" />
                ) : (
                  <ThemeVideo src={showcase.url} className="h-auto w-full object-cover" labels={videoLabels} />
                )}
              </div>
            )}
          </section>
        </Reveal>
      </main>

      <PartnerFooter landing={view.legal} hasContract={view.hasContract} labels={L} className="py-8 text-sm" style={{ borderTop: `1px solid ${p.text}26` }} />
    </div>
  );
}
