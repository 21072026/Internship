import Link from 'next/link';
import { getServerDictionary } from '@/i18n/server';

// Localized 404. Rendered inside the root layout (which sets <html lang>), so
// it inherits the active locale like every other page.
export default async function NotFound() {
  const { t } = await getServerDictionary();
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-gray-900 dark:to-gray-950">
      <div className="text-center">
        <p className="text-6xl font-bold text-blue-600">404</p>
        <h1 className="mt-4 text-2xl font-bold text-gray-900 dark:text-gray-100">{t.notFound.title}</h1>
        <p className="mt-2 text-gray-500 dark:text-gray-400">{t.notFound.description}</p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          {t.notFound.backHome}
        </Link>
      </div>
    </div>
  );
}
