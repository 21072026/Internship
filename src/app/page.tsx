import Link from 'next/link';
import {
  GraduationCap, ArrowRight, ArrowDown, CheckCircle, Users, Building2, Briefcase,
  Github, FlaskConical,
} from 'lucide-react';
import { IS_DEMO_MODE, demoUrl } from '@/lib/demoMode';
import { getFeatures, isFeatureShown } from '@/lib/features';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { roleHome } from '@/lib/roleHome';
import { getServerDictionary, resolveRequestVertical } from '@/i18n/server';
import { verticalCapabilities } from '@/lib/verticals';
import { JsonLd } from '@/components/JsonLd';
import { PublicShell } from '@/components/landing/PublicShell';
import { DemoLink } from '@/components/landing/DemoLink';
import { ProductTour } from '@/components/landing/ProductTour';
import { FOUNDER_NAME, FOUNDER_URL, GITHUB_URL } from '@/components/landing/links';
import { TawkChat } from '@/components/TawkChat';
import { getAllReleaseNotes } from '@/lib/releaseNotes';
import { listPublishedStories } from '@/lib/testimonials';
import { getPublicStats } from '@/lib/publicStats';
import { buildLiveStripPieces } from '@/lib/liveStrip';
import { headers } from 'next/headers';
import { CompanyInquiryForm } from '@/components/CompanyInquiryForm';
import { requestHostHeader, resolvePublicInquiryTarget } from '@/lib/publicHostOrg';
import { formatEur } from '@/lib/money';
import { marketingFromSeatEur } from '@/lib/marketingPlans';

export default async function HomePage() {
  // Only decode a session when one could exist — this is the most-hit page in
  // the app and the overwhelming majority of its visitors are signed out (#1197).
  const session = (await hasSessionCookie()) ? await getServerSession(authOptions) : null;
  if (session) redirect(roleHome(session.user.role));

  const { t, locale } = await getServerDictionary();
  const L = t.landing;

  // Each audience now has a door of its own: mentors apply at /apply-as-mentor
  // (#1072), companies ask for a look at /for-companies (#1102/#1104). Neither
  // may point at /auth/register — token-less sign-up always creates a MENTEE,
  // so a mentor landing there would silently become a mentee.
  const mentorHref = '/apply-as-mentor';
  const companyHref = '/for-companies';

  // Which product is this landing selling (#2500)? Host-resolved for a
  // signed-out visitor, org-resolved when signed in. Both pages follow the same
  // rule — one idea per section, at most one action each (the owner asked for
  // an iPhone-simple page). The internship page: hero → role doors → free core
  // → pipeline → product tour → six features → stories → FAQ → closing band. A
  // MARKETING host gets the same frame without the doors, the free-core band,
  // the product tour and the stories, because those describe the internship
  // loop and would be nonsense to a sales team; it adds its demo form instead. Their copy stays internship-
  // only; the sections that remain are re-worded through the MARKETING overlay
  // in src/i18n/verticalOverlays.ts.
  const vertical = await resolveRequestVertical();
  const isMarketing = vertical === 'MARKETING';
  const caps = verticalCapabilities(vertical);
  const features = getFeatures(t).filter((f) => f.featured && isFeatureShown(f, caps));

  // The marketing landing's demo form (#2569). /for-companies is an internship
  // page (404 here since #2544), so the form lives on this page. It is only OPEN
  // when an org claims this exact host (`Organization.publicHost`) — otherwise
  // the section says so instead of rendering a form whose requests would have
  // nowhere to go (the API answers 503 regardless). Looked up for a marketing
  // host only: the internship landing is the most-hit page in the app and does
  // not grow a query for a form it does not show.
  const demoFormOpen = isMarketing
    ? (await resolvePublicInquiryTarget(requestHostHeader(await headers()))).open
    : false;

  // Consent-gated success stories (#1100). Honesty rule (§4.2): with zero
  // published stories the section does not exist — no heading, no empty grid,
  // no "testimonials coming soon" placeholder. The count is computed live,
  // never written into copy by hand (§4.3).
  const stories = await listPublishedStories(3);

  // Live numbers under the role cards (#1099) — served from the same cached helper the public
  // /api/public/stats endpoint uses, so the landing never fans out its own
  // count() queries per request.
  const livePieces = buildLiveStripPieces(await getPublicStats(), {
    mentors: L.liveMentors,
    openProjects: L.liveProjects,
    waitingCandidates: L.liveWaiting,
  });
  // One quiet chip colour per audience. `-700` text on purpose: a `bg-*-100`
  // chip stays light in dark mode while globals.css lightens `text-*-600`, so a
  // `-600` icon there would go light-on-light.
  const pick = [
    { t: L.pickMenteeT, d: L.pickMenteeD, cta: L.ctaMentee, href: '/auth/register', icon: GraduationCap, badge: 'bg-green-100 text-green-700', testId: undefined },
    { t: L.pickMentorT, d: L.pickMentorD, cta: L.ctaMentor, href: mentorHref, icon: Users, badge: 'bg-blue-100 text-blue-700', testId: 'become-mentor-link' },
    { t: L.pickCompanyT, d: L.pickCompanyD, cta: L.ctaCompany, href: companyHref, icon: Building2, badge: 'bg-indigo-100 text-indigo-700', testId: undefined },
  ];

  // Only claims a stranger can check without an account. The version count is
  // read from the release notes rather than typed in, so it cannot go stale.
  const releaseCount = getAllReleaseNotes().length;

  // Six questions, one flat list per product. The internship page used to group
  // sixteen questions under three role headers; the audience detail now lives on
  // the deep pages (/apply-as-mentor, /for-companies), so the landing keeps the
  // six a first-time visitor actually asks — money, outcome, commitment,
  // longevity, price, speed. The marketing list was always ungrouped (#2500).
  const internshipFaq = [
    { q: L.faqMentee5Q, a: L.faqMentee5A }, { q: L.faqMentee6Q, a: L.faqMentee6A },
    { q: L.faqMentor2Q, a: L.faqMentor2A }, { q: L.faqMentor3Q, a: L.faqMentor3A },
    { q: L.faqCompany3Q, a: L.faqCompany3A }, { q: L.faqCompany1Q, a: L.faqCompany1A },
  ];
  const marketingFaq = [
    { q: L.faqMarketing1Q, a: L.faqMarketing1A }, { q: L.faqMarketing2Q, a: L.faqMarketing2A },
    { q: L.faqMarketing3Q, a: L.faqMarketing3A }, { q: L.faqMarketing4Q, a: L.faqMarketing4A },
    { q: L.faqMarketing5Q, a: L.faqMarketing5A.replace('{from}', formatEur(marketingFromSeatEur(), locale)) }, { q: L.faqMarketing6Q, a: L.faqMarketing6A },
  ];
  const faq = isMarketing ? marketingFaq : internshipFaq;

  const stages = [L.stageApply, L.stageInterview, L.stageInternship, L.stageHired];

  // The founder's name inside the one-line trust row, as a link to them.
  const [trustBefore, trustAfter = ''] = L.trustLine.split('{name}');

  const primaryButton =
    'inline-flex w-full sm:w-auto items-center justify-center gap-2 bg-blue-600 text-white px-7 py-3.5 rounded-xl font-semibold hover:bg-blue-700 transition-all';

  return (
    <PublicShell>

      {/* Hero — a heading, one sentence, one button. It states the loop in that
          one sentence (the old three-card wheel, condensed) and carries no
          sign-up button: the visitor picks a side in the very next section. A
          single "get started" would funnel mentors and companies into the
          mentee sign-up form. The demo button is exempt from that concern — it
          is role-neutral (every visitor can poke the same demo) and hidden on
          the demo itself. */}
      <section className="py-24 sm:py-32 px-4">
        <div className="max-w-3xl mx-auto text-center">
          {/* Marketing only: the overlay's badge is what tells a sales team
              which product this is. The internship promise it used to repeat is
              the headline of the free-core band below. */}
          {isMarketing && (
            <p className="inline-flex rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 mb-8">
              {L.badge}
            </p>
          )}
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-gray-900 leading-tight">
            {L.heroTitle} <span className="text-blue-600">{L.heroAccent}</span>
          </h1>
          <p className="mt-6 text-lg sm:text-xl text-gray-600 max-w-2xl mx-auto">{L.heroSubtitle}</p>
          {!IS_DEMO_MODE && !isMarketing && (
            <div className="mt-10">
              {/* Same-tab on purpose (unchanged): the demo is the destination,
                  not a side trip. */}
              <DemoLink
                href={demoUrl('hero')}
                placement="hero"
                testId="hero-demo-cta"
                className={primaryButton}
              >
                <FlaskConical className="h-5 w-5" /> {L.demoCta}
              </DemoLink>
              <p className="mt-3 text-xs text-gray-500 max-w-md mx-auto">{L.demoCtaNote}</p>
            </div>
          )}
          {isMarketing && demoFormOpen && (
            <div className="mt-10">
              <a href="#demo" data-testid="hero-demo-request" className={primaryButton}>
                <Briefcase className="h-5 w-5" /> {L.demoFormCta}
              </a>
            </div>
          )}
        </div>
      </section>

      {/* Internship-only: the role doors and the free-core band (#2500). */}
      {!isMarketing && (<>
      {/* Pick your side — each card is that audience's door, straight to its
          own page: mentees sign up, mentors apply (#1072), companies ask for a
          look (#1102). A div, not a link, so the door can sit inside it. */}
      <section className="py-20 sm:py-24 px-4 bg-white">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 text-center mb-12">{L.pickTitle}</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {pick.map((p) => (
              <div
                key={p.t}
                data-testid="role-card"
                className="flex flex-col rounded-2xl border border-gray-200 bg-white p-6 transition-all hover:shadow-lg"
              >
                <div className={`w-10 h-10 rounded-lg ${p.badge} flex items-center justify-center mb-4`}>
                  <p.icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-gray-900">{p.t}</h3>
                <p className="mt-2 text-sm text-gray-600 leading-relaxed">{p.d}</p>
                <Link
                  href={p.href}
                  data-testid={p.testId}
                  className="mt-auto pt-4 inline-flex items-center gap-1.5 min-h-[44px] font-medium text-blue-600 hover:underline"
                >
                  {p.cta} <ArrowRight className="h-4 w-4 flex-shrink-0" />
                </Link>
              </div>
            ))}
          </div>
          {/* Live status strip (#1099): real numbers, computed — never written
              into copy by hand (§4.3). A zero piece is not rendered; with all
              three at zero the strip is not in the DOM at all ("0 open
              projects" is worse than nothing). */}
          {livePieces.length > 0 && (
            <p className="mt-8 text-center text-sm text-gray-500" data-testid="hero-live-strip">
              <span className="font-medium">{L.liveNow}</span>{' '}
              {livePieces.join(' · ')}
            </p>
          )}
        </div>
      </section>

      {/* Free core (#1732) — the price answer, right after the doors.
          `heroModel` is the headline verbatim: it is existing shipped copy (it
          used to be a hero sub-line), so promoting it here changes where the
          promise is read, not what it claims.

          Dark mode: `bg-green-50` is retinted by globals.css and the
          `text-green-*` descendants are already covered by the green compound
          override there, so this needs no new rule. Deliberately no
          `bg-green-100` chip inside — that one stays light in dark mode while
          the override would still lighten its text to green-300. */}
      <section
        className="py-16 px-4 bg-green-50 border-y border-green-200"
        data-testid="landing-free-core"
      >
        <div className="max-w-3xl mx-auto text-center">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-green-700">
            <CheckCircle className="h-4 w-4 text-green-600" />
            {L.freeCoreBadge}
          </p>
          <h2 className="mt-4 text-2xl sm:text-3xl font-bold text-gray-900 leading-snug">{L.heroModel}</h2>
          <p className="mt-4 text-base text-gray-600 leading-relaxed">{L.freeCoreBody}</p>
          {/* The CTA the band was built around, restored with the page it
              needs (#1730). */}
          <Link
            href="/pricing"
            data-testid="free-core-cta"
            className="mt-6 inline-flex items-center justify-center rounded-lg bg-green-700 px-5 py-3 text-sm font-semibold text-white hover:bg-green-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2"
          >
            {L.freeCoreCta}
          </Link>
        </div>
      </section>
      </>)}

      {/* Pipeline — four numbered steps. It used to be an SVG with a 680px
          minimum width inside a sideways scroller; a plain list wraps to 2×2 on
          a phone and needs no dark-mode fill classes. No stage count in the
          copy (§7). */}
      <section className="py-20 sm:py-24 px-4">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 text-center">{L.pipelineTitle}</h2>
          <ol className="mt-12 grid grid-cols-2 sm:grid-cols-4 gap-6">
            {stages.map((s, i) => (
              <li key={s} className="flex flex-col items-center text-center gap-3">
                <span className="w-10 h-10 rounded-full bg-blue-600 text-white font-semibold flex items-center justify-center">{i + 1}</span>
                <span className="text-sm font-medium text-gray-900">{s}</span>
              </li>
            ))}
          </ol>
          <p className="mt-10 text-center text-sm text-gray-500">{L.pipelineNote}</p>
        </div>
      </section>

      {/* Product tour (#1399): each host shows its own product's screens — the
          internship set here, SaleVali's pipeline, rep and analytics screens on
          a MARKETING host (ProductTour picks by `marketing`). */}
      <ProductTour t={t} locale={locale} marketing={isMarketing} />

      {/* Features — six titles from the single-source catalogue (#584/#588),
          nothing more; the descriptions and everything else live on /features. */}
      <section className="py-20 sm:py-24 px-4 bg-white">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 text-center mb-12">{L.featuresTitle}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {features.slice(0, 6).map((f) => (
              <div key={f.title} className="rounded-2xl border border-gray-200 bg-white p-5 transition-all hover:shadow-md">
                <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center mb-4">
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-gray-900 leading-snug">{f.title}</h3>
              </div>
            ))}
          </div>
          <div className="text-center mt-8">
            <Link href="/features" className="inline-flex items-center gap-1.5 min-h-[44px] text-blue-600 hover:underline font-medium" data-testid="all-features-link">
              {t.featureCatalog.allFeatures} <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Success stories (#1100), internship-only (#2500) — rendered ONLY when
          at least one published, consent-gated story exists; otherwise this
          section is not in the DOM at all (docs/landing-value-proposition.md
          §4.2 honesty rule). */}
      {!isMarketing && stories.length > 0 && (
        <section className="py-20 sm:py-24 px-4" data-testid="landing-stories">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 text-center mb-12">{L.stories.title}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              {stories.map((s) => (
                <figure key={s.id} className="rounded-2xl border border-gray-200 bg-white p-6">
                  <blockquote className="text-sm text-gray-700 leading-relaxed">“{s.excerpt}”</blockquote>
                  <figcaption className="mt-4 text-sm">
                    <span className="font-medium text-gray-900">{s.name}</span>
                    <span className="text-gray-500"> · {L.stories.roles[s.role]}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
            <div className="mt-6 text-center">
              <Link href="/stories" className="text-sm text-blue-600 hover:underline">{L.stories.viewAll}</Link>
            </div>
          </div>
        </section>
      )}

      {/* FAQ — both products (the marketing one has its own questions). */}
      {/* The same `faq` array as the list below (#1382): a copy of the text
          would be the one place that silently went stale on the next edit. */}
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faq.map((item) => ({
            '@type': 'Question',
            name: item.q,
            acceptedAnswer: { '@type': 'Answer', text: item.a },
          })),
        }}
      />
      <section className={`py-20 sm:py-24 px-4 ${stories.length > 0 && !isMarketing ? 'bg-white' : ''}`} data-testid="landing-faq">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 text-center mb-12">{L.faqTitle}</h2>
          <div className="space-y-3">
            {faq.map((item) => (
              <details key={item.q} className="group bg-white border border-gray-200 rounded-xl p-4">
                <summary className="font-medium text-gray-900 cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-start justify-between gap-3">
                  <span>{item.q}</span>
                  <ArrowDown className="h-4 w-4 text-gray-400 flex-shrink-0 mt-1 transition-transform group-open:rotate-180" />
                </summary>
                <p className="mt-3 text-sm text-gray-600 leading-relaxed">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {isMarketing && (
        <section id="demo" className="py-20 sm:py-24 px-4 bg-white scroll-mt-16" data-testid="landing-demo-form">
          <div className="max-w-2xl mx-auto">
            <div className="text-center mb-8">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900">{L.demoFormTitle}</h2>
              <p className="text-gray-600 mt-3">{L.demoFormSubtitle}</p>
            </div>
            {demoFormOpen ? (
              <CompanyInquiryForm variant="marketing" />
            ) : (
              <div
                data-testid="landing-demo-unavailable"
                className="rounded-2xl border border-gray-200 bg-gray-50 p-8 text-center"
              >
                <h3 className="font-semibold text-gray-900 mb-2">{t.forCompanies.unavailableTitle}</h3>
                <p className="text-sm text-gray-600">{t.forCompanies.unavailableBody}</p>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Closing band — one button, one line of other doors, one demo line,
          one trust row. Repeating the mentor and company doors as outline
          buttons was three equal-weight choices at the end of a page that had
          already asked; dropping them entirely sent a mentor who answered the
          band's "which side?" into the mentee sign-up. */}
      <section className="py-20 sm:py-24 px-4">
        <div className="max-w-4xl mx-auto text-center bg-gradient-to-r from-blue-600 to-indigo-600 rounded-3xl p-8 sm:p-14">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-3">{L.ctaTitle}</h2>
          <p className="text-blue-100 mb-8 max-w-2xl mx-auto">{L.ctaSubtitle}</p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            {/* Marketing is invitation-only (#2501): its one door is sign-in, not
                the token-less mentee sign-up. */}
            <Link href={isMarketing ? '/auth/signin' : '/auth/register'} className="inline-flex items-center justify-center gap-2 bg-white text-blue-700 px-7 py-3.5 rounded-xl font-semibold hover:bg-blue-50 transition-colors dark:!bg-white dark:!text-blue-700 dark:hover:!bg-blue-100">
              {L.ctaMentee} <ArrowRight className="h-5 w-5" />
            </Link>
            {isMarketing && demoFormOpen && (
              <a
                href="#demo"
                data-testid="cta-demo-request"
                className="inline-flex items-center justify-center gap-2 border-2 border-white/60 text-white px-7 py-3.5 rounded-xl font-semibold hover:bg-white/10 transition-colors"
              >
                <Briefcase className="h-5 w-5" /> {L.demoFormCta}
              </a>
            )}
          </div>
          {/* The band's question speaks to all three sides, but its one button
              is the mentee sign-up (token-less, so always a MENTEE). Mentors and
              companies get their own doors as a quiet text line, never a second
              and third button. */}
          {!isMarketing && (
            <p data-testid="cta-other-doors" className="mt-4 text-sm text-blue-100">
              <Link href={mentorHref} className="text-white underline hover:text-blue-50 font-medium">{L.ctaMentor}</Link>
              {' · '}
              <Link href={companyHref} className="text-white underline hover:text-blue-50 font-medium">{L.ctaCompany}</Link>
            </p>
          )}
          {!IS_DEMO_MODE && !isMarketing && (
            <p className="mt-4 text-sm text-blue-100">
              {L.demoCtaInline}{' '}
              <DemoLink
                href={demoUrl('cta')}
                placement="cta"
                testId="cta-demo-link"
                className="text-white underline hover:text-blue-50 font-medium"
              >
                {L.demoCta}
              </DemoLink>
            </p>
          )}
          {/* Trust row — what the old transparency section said in four cards,
              in one line: it is a beta, a named person builds it (#1097, §4.1 —
              a real person, never a company as the owner), the source is open,
              and the release history is public (internship only: the feed
              404s on a marketing host, #2544). */}
          <div className="mt-8 pt-6 border-t border-white/20 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-blue-50">
            <span data-testid="founder-identity">
              {trustBefore}
              <a href={FOUNDER_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">{FOUNDER_NAME}</a>
              {trustAfter}
            </span>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 underline hover:text-white">
              <Github className="h-4 w-4" />{L.trans1T} · AGPL-3.0
            </a>
            {!isMarketing && (
              <Link href="/release-notes" className="underline hover:text-white">
                {L.trans2T.replace('{n}', String(releaseCount))}
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* Live chat for visitors who would rather ask than read (#1174). Landing
          page only, and only once marketing cookies are accepted. */}
      <TawkChat />
    </PublicShell>
  );
}
