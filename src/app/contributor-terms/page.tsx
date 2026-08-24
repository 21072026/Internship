import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { acceptanceHistory, getActiveTerms, hasAcceptedContributorTerms } from '@/lib/contributorTerms';
import { templateToHtml } from '@/lib/renderTemplate';
import { formatDate } from '@/lib/relativeTime';
import { ContributorTermsDownload } from '@/components/ContributorTermsDownload';
import { ContributorTermsAccept } from '@/components/ContributorTermsAccept';

export const dynamic = 'force-dynamic';

// The permanent copy (#1025). Two of the five properties that make the
// click-wrap hold up live here: the person can read back — and take away — the
// exact text they accepted, and the text is reachable in ONE CLICK WITHOUT
// SIGNING IN. That second one is why this page is public: a link that first
// demands a login is not a link to the terms, and the wording is public in
// CONTRIBUTING.md anyway. Only the personal part — what *you* accepted, and the
// accept box itself — needs a session.
export default async function ContributorTermsPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const session = (await hasSessionCookie()) ? await getServerSession(authOptions) : null;

  const { locale, t } = await getServerDictionary();
  const c = t.contributorTerms;
  const terms = await getActiveTerms(undefined, locale);

  const [history, accepted] = session
    ? await Promise.all([
        acceptanceHistory(session.user.id),
        hasAcceptedContributorTerms(session.user.id),
      ])
    : [[], false];

  // Only ever an in-app path, never an absolute URL an attacker could supply.
  const nextHref = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

  return (
    <PublicShell>
      <div className="max-w-3xl mx-auto my-10 px-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{c.title}</h1>

          {!terms ? (
            <p className="mt-4 text-sm text-gray-600 dark:text-gray-300">{c.noneConfigured}</p>
          ) : (
            <>
              <p className="mt-1 text-xs text-gray-400">
                {c.versionLabel}: {terms.version} · {c.effectiveFrom}: {formatDate(terms.effectiveFrom, locale)}
              </p>
              {/* Being shown a translation is fine; not knowing it is one is not. */}
              {terms.authoritativeLocale && (
                <p
                  data-testid="terms-translation-notice"
                  className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
                >
                  {c.translationNotice.replace('{locale}', terms.authoritativeLocale.toUpperCase())}
                </p>
              )}

              <article
                data-testid="terms-body"
                className="prose prose-sm dark:prose-invert mt-5 max-w-none text-gray-700 dark:text-gray-200 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_li]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
                dangerouslySetInnerHTML={{ __html: templateToHtml(terms.body) }}
              />

              <ContributorTermsDownload
                body={terms.body}
                filename={`contributor-terms-${terms.key}-v${terms.version}-${terms.locale}.md`}
                label={c.download}
              />

              {session && !accepted && (
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
              )}
              {session && accepted && (
                <p data-testid="terms-already-accepted" className="mt-6 rounded-lg bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-800 px-3 py-2 text-sm text-green-800 dark:text-green-200">
                  {c.accepted} · {c.versionLabel} {terms.version}
                </p>
              )}
            </>
          )}

          {session ? (
            <section className="mt-8 border-t border-gray-100 dark:border-gray-800 pt-5">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{c.historyTitle}</h2>
              {history.length === 0 ? (
                <p className="mt-2 text-sm text-gray-500">{c.historyEmpty}</p>
              ) : (
                <ul data-testid="terms-history" className="mt-2 space-y-1.5">
                  {history.map((h) => (
                    <li key={`${h.termsKey}-${h.version}-${h.projectId ?? 'platform'}`} className="text-sm text-gray-600 dark:text-gray-300">
                      <span className="font-medium">{h.termsKey} v{h.version}</span>
                      {' · '}
                      {h.projectId ? c.scopeProject : c.scopePlatform}
                      {' · '}
                      {formatDate(h.acceptedAt, locale)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <p className="mt-8 border-t border-gray-100 dark:border-gray-800 pt-5 text-sm text-gray-500">
              <Link href="/auth/signin" className="text-blue-600 hover:underline">{c.signInToAccept}</Link>
            </p>
          )}
        </div>
      </div>
    </PublicShell>
  );
}
