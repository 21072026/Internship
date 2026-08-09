import Link from 'next/link';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';

const REPO_COC_URL = 'https://github.com/21072026/Internship/blob/main/CODE_OF_CONDUCT.md';

// Public code of conduct — the participant-facing summary. The full contributor
// version (EN/TR/DE) lives in the repository, linked at the bottom.
export default async function CodeOfConductPage() {
  const { t } = await getServerDictionary();
  const c = t.codeOfConduct;
  return (
    <PublicShell>
      <div className="max-w-2xl mx-auto my-12 px-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">{c.title}</h1>
          <div className="space-y-6 text-sm text-gray-600 dark:text-gray-300">
            <p>{c.intro}</p>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{c.expectedTitle}</h2>
              <ul className="list-disc pl-5 space-y-1">
                {c.expected.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{c.unacceptableTitle}</h2>
              <ul className="list-disc pl-5 space-y-1">
                {c.unacceptable.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{c.scopeTitle}</h2>
              <p>{c.scope}</p>
            </section>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{c.reportTitle}</h2>
              <p>{c.report}</p>
            </section>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{c.enforcementTitle}</h2>
              <p>{c.enforcement}</p>
            </section>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{c.repoTitle}</h2>
              <p>{c.repoBody}</p>
              <a
                href={REPO_COC_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block mt-2 text-blue-600 hover:underline"
              >
                {c.repoLink} →
              </a>
            </section>
          </div>
          <Link href="/" className="inline-block mt-6 text-sm text-blue-600 hover:underline">
            ← {c.back}
          </Link>
        </div>
      </div>
    </PublicShell>
  );
}
