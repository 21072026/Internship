import Link from 'next/link';
import { getServerDictionary } from '@/i18n/server';

// Public terms of service.
export default async function TermsPage() {
  const { t } = await getServerDictionary();
  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto bg-white rounded-2xl border border-gray-200 p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">{t.terms.title}</h1>
        <div className="space-y-3 text-sm text-gray-600">
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
  );
}
