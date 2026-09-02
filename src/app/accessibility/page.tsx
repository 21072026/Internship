import Link from 'next/link';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { operatorIdentity } from '@/lib/imprint';
import { GITHUB_URL } from '@/components/landing/links';
import {
  ACCESSIBILITY_EVIDENCE,
  ACCESSIBILITY_LIMITATIONS,
  ACCESSIBILITY_RESPONSE_DAYS,
  ACCESSIBILITY_SCANNED_PAGES,
  ACCESSIBILITY_STATEMENT_REVIEWED,
  issueUrl,
  repoFileUrl,
} from '@/lib/accessibility';

// Same reason as /privacy and /imprint: the operator identity comes from the
// deployment's env, which only exists at runtime. Prerendering would freeze
// "no contact address published" into the image (see src/lib/imprint.ts).
export const dynamic = 'force-dynamic';

/**
 * The public accessibility conformance statement (#2035).
 *
 * Under the European Accessibility Act this stopped being marketing copy: a
 * statement naming the standard, the scope, the known gaps, a feedback channel
 * and an escalation route is what EN 301 549 procurement expects to find. What
 * makes it worth reading is the "known limitations" section — a statement whose
 * defects list is empty is a claim, not evidence, which is why the list is a
 * required part of the page and an e2e spec asserts it is non-empty.
 *
 * Facts, sources and issue numbers live in src/lib/accessibility.ts; the prose
 * is the `accessibility` namespace (server-only). The canonical long form is
 * docs/accessibility-statement.md.
 */
export default async function AccessibilityPage() {
  const { t } = await getServerDictionary();
  const a = t.accessibility;

  // Never a literal address. This deployment's operator publishes one or it
  // does not, exactly as /privacy does it — and when it does not, the page says
  // so and points at the channel that still works, rather than inventing one.
  const operator = operatorIdentity();
  const feedbackBody = operator
    ? a.feedbackBody.replace('{email}', operator.email).replace('{days}', String(ACCESSIBILITY_RESPONSE_DAYS))
    : a.feedbackUnset;

  return (
    <PublicShell>
      <div className="max-w-2xl mx-auto my-12 px-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">{a.title}</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-5">
            {a.reviewedLabel}: {ACCESSIBILITY_STATEMENT_REVIEWED}
          </p>

          <p className="text-sm text-gray-600 dark:text-gray-300">{a.intro}</p>

          {/* The headline answer, before any of the reasoning. */}
          <div
            data-testid="accessibility-status"
            className="mt-5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-4 py-3"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">
              {a.statusLabel}
            </p>
            <p className="mt-1 text-sm font-semibold text-amber-900 dark:text-amber-100">{a.statusValue}</p>
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">{a.statusExplainer}</p>
          </div>

          <div className="mt-8 space-y-8 text-sm text-gray-600 dark:text-gray-300">
            <section>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">{a.standardTitle}</h2>
              <p>{a.standardBody}</p>
              <p className="mt-2">{a.standardEuBody}</p>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">{a.scopeTitle}</h2>
              <p>{a.scopeBody}</p>
              <p className="mt-2">{a.scopeTestedIntro}</p>
              <ul data-testid="accessibility-scope" className="mt-2 flex flex-wrap gap-1.5">
                {ACCESSIBILITY_SCANNED_PAGES.map((p) => (
                  <li
                    key={p}
                    className="rounded border border-gray-200 dark:border-gray-700 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:text-gray-200"
                  >
                    {p}
                  </li>
                ))}
              </ul>
              <p className="mt-2">{a.scopeTestedNote}</p>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">{a.evidenceTitle}</h2>
              <p>{a.evidenceIntro}</p>
              {/* Every claim carries the file that makes it checkable — the
                  point of the page is that a reader need not take our word. */}
              <ul data-testid="accessibility-evidence" className="mt-3 space-y-3">
                {ACCESSIBILITY_EVIDENCE.map((e) => (
                  <li key={e.key}>
                    <span>{a.evidence[e.key]}</span>{' '}
                    <a
                      href={repoFileUrl(e.source)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-blue-600 hover:underline whitespace-nowrap"
                    >
                      {e.source}
                    </a>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">{a.limitationsTitle}</h2>
              <p>{a.limitationsIntro}</p>
              <ul data-testid="accessibility-limitations" className="mt-3 space-y-3">
                {ACCESSIBILITY_LIMITATIONS.map((l) => (
                  <li key={l.key}>
                    <span>{a.limitations[l.key as keyof typeof a.limitations]}</span>{' '}
                    {l.issue ? (
                      <a
                        href={issueUrl(l.issue)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                      >
                        {a.limitationTracked.replace('{issue}', `#${l.issue}`)}
                      </a>
                    ) : (
                      <span className="text-xs text-gray-500 dark:text-gray-400">{a.limitationUntracked}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">{a.feedbackTitle}</h2>
              <p data-testid="accessibility-feedback">{feedbackBody}</p>
              <p className="mt-2">
                {a.feedbackAlternative}{' '}
                <a
                  href={`${GITHUB_URL}/issues`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  {a.feedbackAlternativeLink}
                </a>
              </p>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">{a.enforcementTitle}</h2>
              <p>{a.enforcementBody}</p>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">{a.maintenanceTitle}</h2>
              <p>{a.maintenanceBody}</p>
            </section>

            <p className="flex flex-wrap gap-4">
              <Link href="/imprint" className="text-blue-600 hover:underline" data-testid="accessibility-imprint-link">
                {a.imprintLink} →
              </Link>
              <Link href="/privacy" className="text-blue-600 hover:underline">
                {a.privacyLink} →
              </Link>
            </p>
          </div>

          <Link href="/" className="inline-block mt-8 text-sm text-blue-600 hover:underline">
            ← {a.back}
          </Link>
        </div>
      </div>
    </PublicShell>
  );
}
