import Link from 'next/link';
import { GraduationCap, Sparkles } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { RELEASE_NOTES } from '@/lib/releaseNotes';
import { APP_VERSION, GIT_SHA } from '@/lib/version';

// Public, user-facing "what's new" page — friendly feature highlights per
// release, localized. Distinct from CHANGELOG.md (developer-facing, in the repo).
export default async function ReleaseNotesPage() {
  const { locale, t } = await getServerDictionary();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-blue-600" /> {t.releaseNotes.title}
          </h1>
          <span className="text-xs text-gray-400">v{APP_VERSION} · {GIT_SHA}</span>
        </div>

        <div className="space-y-6">
          {RELEASE_NOTES.map((r) => (
            <div key={r.version} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">v{r.version}</h2>
                <span className="text-xs text-gray-400">{r.date}</span>
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
    </div>
  );
}
