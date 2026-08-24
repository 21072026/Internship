import { notFound } from 'next/navigation';
import { Quote } from 'lucide-react';
import Link from 'next/link';
import { getServerDictionary } from '@/i18n/server';
import { listPublishedStories } from '@/lib/testimonials';
import { PublicShell } from '@/components/landing/PublicShell';

// Published, consent-gated success stories (#1100). The honesty rule from
// docs/landing-value-proposition.md §4.2 applies here too: with zero
// published stories this page is a 404, never an empty shell or a
// "testimonials coming soon" placeholder.
export const dynamic = 'force-dynamic';

export default async function StoriesPage() {
  const stories = await listPublishedStories(50);
  if (stories.length === 0) notFound();
  const { t, locale } = await getServerDictionary();
  const S = t.landing.stories;

  return (
    <PublicShell>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">{S.pageTitle}</h1>
        <p className="text-gray-500 dark:text-gray-400 mb-10">{S.pageSubtitle}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5" data-testid="stories-list">
          {stories.map((s) => (
            <figure key={s.id} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6" data-testid={`story-${s.id}`}>
              <Quote className="h-5 w-5 text-blue-600 mb-3" aria-hidden="true" />
              <blockquote className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">“{s.excerpt}”</blockquote>
              <figcaption className="mt-4 text-sm">
                {s.profileUrl ? (
                  <Link href={s.profileUrl} className="font-medium text-gray-900 dark:text-gray-100 hover:underline">
                    {s.name}
                  </Link>
                ) : (
                  <span className="font-medium text-gray-900 dark:text-gray-100">{s.name}</span>
                )}
                <span className="text-gray-400"> · {S.roles[s.role]}</span>
                <span className="block text-xs text-gray-400 mt-0.5">
                  {new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(s.publishedAt))}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </PublicShell>
  );
}
