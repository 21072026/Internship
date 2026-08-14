import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FlaskConical, RotateCcw, ShieldOff } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { IS_DEMO_MODE, DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/lib/demoMode';

export const dynamic = 'force-dynamic';

// Landing page for the public demo (#966): the three sign-in identities, and an
// honest list of what the demo will not let you do.
//
// 404s off the demo deployment. The credentials are synthetic and public, so
// this is not a secret worth protecting — but a /demo page on crm.ersah.in that
// advertises accounts which do not exist there would just be a broken page.
export default async function DemoPage() {
  if (!IS_DEMO_MODE) notFound();
  const { t } = await getServerDictionary();

  const roleLabel = (role: 'admin' | 'mentor' | 'mentee') => t.demo.roles[role];

  return (
    <PublicShell>
      <div className="max-w-3xl mx-auto px-4 py-12">
        <div className="flex items-center gap-3 mb-2">
          <FlaskConical className="h-7 w-7 text-amber-600" aria-hidden="true" />
          <h1 className="text-3xl font-bold text-gray-900">{t.demo.title}</h1>
        </div>
        <p className="text-gray-500 mb-8">{t.demo.subtitle}</p>

        <h2 className="text-lg font-semibold text-gray-900 mb-3">{t.demo.credentialsTitle}</h2>
        <div className="overflow-x-auto">
          <table data-testid="demo-credentials" className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-2 font-medium text-gray-700">{t.demo.colRole}</th>
                <th className="px-4 py-2 font-medium text-gray-700">{t.demo.colEmail}</th>
                <th className="px-4 py-2 font-medium text-gray-700">{t.demo.colPassword}</th>
              </tr>
            </thead>
            <tbody>
              {DEMO_ACCOUNTS.map((a) => (
                <tr key={a.email} className="border-t border-gray-200">
                  <td className="px-4 py-2 text-gray-700">{roleLabel(a.role)}</td>
                  <td className="px-4 py-2 font-mono text-gray-900">{a.email}</td>
                  <td className="px-4 py-2 font-mono text-gray-900">{DEMO_PASSWORD}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Link
          href="/auth/signin"
          className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 mt-6 text-sm font-medium text-white hover:bg-blue-700"
        >
          {t.demo.signInCta}
        </Link>

        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="flex items-center gap-2 font-semibold text-gray-900 mb-2">
              <RotateCcw className="h-4 w-4 text-gray-500" aria-hidden="true" />
              {t.demo.resetTitle}
            </h3>
            <p className="text-sm text-gray-600">{t.demo.resetBody}</p>
          </div>
          <div>
            <h3 className="flex items-center gap-2 font-semibold text-gray-900 mb-2">
              <ShieldOff className="h-4 w-4 text-gray-500" aria-hidden="true" />
              {t.demo.limitsTitle}
            </h3>
            <ul className="text-sm text-gray-600 list-disc pl-5 space-y-1">
              <li>{t.demo.limitAccounts}</li>
              <li>{t.demo.limitEmail}</li>
              <li>{t.demo.limitUploads}</li>
            </ul>
          </div>
        </div>

        <p className="mt-10 text-sm text-gray-500">
          {t.demo.realAccount}{' '}
          <Link href="/" className="underline hover:no-underline">
            {t.demo.realAccountLink}
          </Link>
        </p>
      </div>
    </PublicShell>
  );
}
