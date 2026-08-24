import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { getActiveTerms, hasAcceptedContributorTerms } from '@/lib/contributorTerms';
import { templateToHtml } from '@/lib/renderTemplate';
import { formatDate } from '@/lib/relativeTime';
import { ContributorTermsAccept } from '@/components/ContributorTermsAccept';

export const dynamic = 'force-dynamic';

// The onboarding step (#1025): the full text on screen, an unticked box, accept.
//
// It is a step of its own rather than a paragraph inside OnboardingForm on
// purpose — the gate on the contributor surfaces needs somewhere to send people
// who are long past onboarding, and a step with its own URL is that place. The
// text is rendered here in full, not linked: a click-wrap where the wording sits
// behind a link the person never opened is the weak version of this.
export default async function ContributorTermsStepPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin?callbackUrl=/onboarding/contributor-terms');

  const { next } = await searchParams;
  const nextHref = next && next.startsWith('/') && !next.startsWith('//') ? next : '/portal/projects';

  const { locale, t } = await getServerDictionary();
  const c = t.contributorTerms;
  const terms = await getActiveTerms(undefined, locale);

  // Nothing to accept — either no terms are configured or this user is already
  // on the current version. Either way the step has no work to do; send them on
  // instead of showing an acceptance screen that would accept nothing.
  if (!terms || (await hasAcceptedContributorTerms(session.user.id))) redirect(nextHref);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-gray-950 dark:to-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl my-10">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{c.stepTitle}</h1>
          <p className="text-gray-500 mt-1 text-sm">{c.stepSubtitle}</p>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-8">
          <p className="text-xs text-gray-400">
            {c.versionLabel}: {terms.version} · {c.effectiveFrom}: {formatDate(terms.effectiveFrom, locale)}
          </p>
          {terms.authoritativeLocale && (
            <p
              data-testid="terms-translation-notice"
              className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
            >
              {c.translationNotice.replace('{locale}', terms.authoritativeLocale.toUpperCase())}
            </p>
          )}

          {/* Scrollable, but complete: the whole text is in the DOM before the
              click, which is the property that matters — not that it happens to
              fit on one screen. */}
          <article
            data-testid="terms-body"
            className="prose prose-sm dark:prose-invert mt-4 max-h-[26rem] overflow-y-auto rounded-lg border border-gray-100 dark:border-gray-800 p-4 max-w-none text-gray-700 dark:text-gray-200 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_li]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
            dangerouslySetInnerHTML={{ __html: templateToHtml(terms.body) }}
          />

          <ContributorTermsAccept
            version={terms.version}
            termsKey={terms.key}
            nextHref={nextHref}
            labels={{
              intro: c.acceptIntro,
              checkbox: c.acceptCheckbox,
              button: c.acceptButton,
              versionChanged: c.versionChanged,
            }}
          />
        </div>
      </div>
    </div>
  );
}
