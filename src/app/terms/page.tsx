import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/pageMetadata';
import Link from 'next/link';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata((t) => ({ title: t.terms.title, description: t.seo.termsDescription }));
}


// Public terms of service.
export default async function TermsPage() {
  const { t } = await getServerDictionary();
  return (
    <PublicShell breadcrumb={{ name: t.terms.title, path: '/terms' }}>
      <div className="max-w-2xl mx-auto my-12 px-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">{t.terms.title}</h1>
          <div className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
            <p>{t.terms.intro}</p>
            <p>{t.terms.use}</p>
            <p>{t.terms.accounts}</p>
            <p>{t.terms.liability}</p>
            <p>{t.terms.changes}</p>
          </div>
          <Link href="/" className="inline-block mt-6 text-sm text-blue-600 hover:underline">
            ← {t.terms.back}
          </Link>
        </div>
      </div>
    </PublicShell>
  );
}
