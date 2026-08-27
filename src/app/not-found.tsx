import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicShell } from '@/components/landing/PublicShell';
import { getServerDictionary } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDictionary();

  return {
    title: t.notFound.title,
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default async function NotFound() {
  const { t } = await getServerDictionary();

  const doors = [
    { href: '/auth/register', label: t.publicNav.register },
    { href: '/apply-as-mentor', label: t.publicNav.becomeMentor },
    { href: '/for-companies', label: t.forCompanies.nav },
  ];

  return (
    <PublicShell>
      <section className="flex min-h-[60vh] items-center justify-center px-4 py-16">
        <div className="w-full max-w-3xl text-center">
          <p className="text-6xl font-bold text-blue-600">404</p>

          <h1 className="mt-4 text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t.notFound.title}
          </h1>

          <p className="mt-2 text-gray-500 dark:text-gray-400">
            {t.notFound.description}
          </p>

          <Link
            href="/"
            className="mt-6 inline-block rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            {t.notFound.backHome}
          </Link>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {doors.map((door) => (
              <Link
                key={door.href}
                href={door.href}
                className="rounded-xl border border-gray-200 bg-white p-5 text-sm font-medium text-gray-800 shadow-sm transition hover:border-blue-300 hover:shadow-md dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              >
                {door.label}
              </Link>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap justify-center gap-4 text-sm">
            <Link href="/features" className="text-blue-600 hover:underline">
              {t.publicNav.features}
            </Link>

            <Link href="/projects" className="text-blue-600 hover:underline">
              {t.projects.title}
            </Link>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}