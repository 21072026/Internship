import Link from 'next/link';
import { GraduationCap, Sparkles } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { getAllReleaseNotes } from '@/lib/releaseNotes';
import { APP_VERSION, GIT_SHA } from '@/lib/version';
import { PublicShell } from '@/components/landing/PublicShell';
import { GITHUB_URL } from '@/components/landing/links';

// Public, user-facing "what's new" page — friendly feature highlights per
// release, localized. Distinct from CHANGELOG.md (developer-facing, in the repo).
export default async function ReleaseNotesPage() {
  const { locale, t } = await getServerDictionary();

  return (
    <PublicShell>
      <div className="max-w-2xl mx-auto my-12 px-4">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-blue-600" /> {t.releaseNotes.title}
          </h1>
          <span className="text-xs text-gray-400">v{APP_VERSION} · {GIT_SHA}</span>
        </div>

        <div className="space-y-6">
          {getAllReleaseNotes().map((r) => (
            <div key={r.version} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
              {/* Stacks on a phone: version + "2026-08-25 09:25 UTC · b174c20"
                  side by side is wider than 360px (e2e/mobile-layout-audit). */}
              <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-3 mb-3">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">v{r.version}</h2>
                <span className="text-xs text-gray-400 sm:text-right">
                  {r.date}
                  {r.time ? ` ${r.time} UTC` : ''}
                  {r.commit ? (
                    <>
                      {' · '}
                      <a
                        href={`${GITHUB_URL}/commit/${r.commit}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono hover:underline hover:text-blue-600"
                      >
                        {r.commit}
                      </a>
                    </>
                  ) : null}
                </span>
              </div>
              <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-300 list-disc list-inside">
                {r.highlights[locale].map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <Link href="/" className="inline-flex items-center gap-1.5 mt-8 text-sm text-blue-600 hover:underline">
          <GraduationCap className="h-4 w-4" /> {t.releaseNotes.back}
        </Link>
      </div>
    </PublicShell>
  );
}
