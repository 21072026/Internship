import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';

const REPO_AI_DOC_URL = 'https://github.com/21072026/Internship/blob/main/docs/ai.md';

/**
 * Public AI transparency page (#2034) — the page a privacy reviewer reads
 * before deciding whether this product may touch their candidates' data.
 *
 * Everything here is checked against `docs/ai.md`, which is checked against the
 * code. The rule for both is the same and it is the only rule: **write what is
 * true today**. Where the answer is "we have not done that yet" the page says
 * so and says what happens instead — an overclaim on this page costs more trust
 * than the gap it papers over.
 */
export default async function AiPage() {
  const { t } = await getServerDictionary();
  const a = t.ai;

  const sections: { title: string; body: string }[] = [
    { title: a.providerTitle, body: a.providerBody },
    { title: a.trainingTitle, body: a.trainingBody },
    { title: a.consentTitle, body: a.consentBody },
    { title: a.offTitle, body: a.offBody },
    { title: a.humanTitle, body: a.humanBody },
    { title: a.retentionTitle, body: a.retentionBody },
    { title: a.markerTitle, body: a.markerBody },
  ];

  return (
    <PublicShell>
      <div className="max-w-2xl mx-auto my-12 px-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="h-5 w-5 text-indigo-600" aria-hidden="true" />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{a.title}</h1>
          </div>

          <div className="space-y-6 text-sm text-gray-600 dark:text-gray-300">
            <p>{a.intro}</p>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{a.tasksTitle}</h2>
              <p className="mb-3">{a.tasksIntro}</p>
              <ul className="space-y-3" data-testid="ai-tasks">
                {a.tasks.map((task) => (
                  <li
                    key={task.name}
                    className="rounded-xl border border-gray-200 dark:border-gray-800 p-4"
                  >
                    <p className="font-medium text-gray-900 dark:text-gray-100">{task.name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{task.audience}</p>
                    <dl className="mt-2 space-y-1">
                      {[
                        { label: a.sentLabel, value: task.sent },
                        { label: a.withheldLabel, value: task.withheld },
                        { label: a.consentLabel, value: task.consent },
                      ].map((row) => (
                        <div key={row.label} className="sm:flex sm:gap-2">
                          <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 sm:w-40 sm:flex-shrink-0">
                            {row.label}
                          </dt>
                          <dd className="text-sm">{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
            </section>

            {sections.map((s) => (
              <section key={s.title}>
                <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{s.title}</h2>
                <p>{s.body}</p>
              </section>
            ))}

            {/* The section that makes the rest of the page credible: the things
                we have NOT done, named, rather than left for a reviewer to
                discover by asking. */}
            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{a.notYetTitle}</h2>
              <p className="mb-2">{a.notYetIntro}</p>
              <ul className="list-disc pl-5 space-y-1" data-testid="ai-not-yet">
                {a.notYet.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{a.docsTitle}</h2>
              <p>{a.docsBody}</p>
              <a
                href={REPO_AI_DOC_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block mt-2 text-blue-600 hover:underline"
              >
                {a.docsLink} →
              </a>
            </section>

            <p className="text-sm">
              <Link href="/privacy" className="text-blue-600 hover:underline" data-testid="ai-privacy-link">
                {a.privacyLinkLabel} →
              </Link>
            </p>
          </div>

          <Link href="/" className="inline-block mt-6 text-sm text-blue-600 hover:underline">
            ← {a.back}
          </Link>
        </div>
      </div>
    </PublicShell>
  );
}
