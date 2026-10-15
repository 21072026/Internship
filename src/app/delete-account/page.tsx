import type { Metadata } from 'next';
import Link from 'next/link';
import { UserX } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { pageMetadata } from '@/lib/pageMetadata';
import { operatorIdentityForRequest } from '@/lib/imprintRequest';
import { hostBrand } from '@/lib/hostBrand';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata((t) => ({ title: t.deleteAccount.title, description: t.deleteAccount.description }));
}

// The operator's address comes from the deployment's env at runtime, and the
// product name from the host — neither may be frozen into the image.
export const dynamic = 'force-dynamic';

/**
 * Public "how do I delete my account" page (docs/mobile-strategy.md).
 *
 * Google Play requires every app that lets people create an account to link a
 * page that explains deletion and is reachable WITHOUT the app — the in-app
 * path (/account → DELETE /api/account) alone does not satisfy it. The page is
 * a description of `hardDeleteUser` (src/lib/accountErasure.ts), not a promise
 * beyond it: if erasure changes, this copy changes in the same diff.
 *
 * Lives at /delete-account, not /account-deletion: robots.ts disallows the
 * `/account` prefix, which would have hidden it from the crawler Play uses.
 */
export default async function DeleteAccountPage() {
  const [{ t }, operator, brand] = await Promise.all([
    getServerDictionary(),
    operatorIdentityForRequest(),
    hostBrand(),
  ]);
  const d = t.deleteAccount;
  const noAccess = operator ? d.noAccessBody.replace('{email}', operator.email) : d.noAccessUnset;

  return (
    <PublicShell breadcrumb={{ name: d.title, path: '/delete-account' }}>
      <div className="max-w-2xl mx-auto my-12 px-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8">
          <div className="flex items-center gap-2 mb-4">
            <UserX className="h-5 w-5 text-red-600" aria-hidden="true" />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{d.title}</h1>
          </div>

          <div className="space-y-6 text-sm text-gray-600 dark:text-gray-300">
            <p>{d.intro.replace('{product}', brand.productName)}</p>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{d.selfTitle}</h2>
              <ol className="list-decimal pl-5 space-y-1" data-testid="delete-account-steps">
                {d.selfSteps.map((step) => <li key={step}>{step}</li>)}
              </ol>
              {/* /account sends a signed-out visitor to sign-in and then back
                  to /account (callbackUrl), so one link serves both. */}
              <Link
                href="/account"
                className="inline-block mt-3 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
                data-testid="delete-account-cta"
              >
                {d.selfCta}
              </Link>
              <p className="mt-3">{d.exportHint}</p>
            </section>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{d.noAccessTitle}</h2>
              <p>
                {d.noAccessReset}{' '}
                <Link href="/auth/forgot" className="text-blue-600 hover:underline">{d.noAccessResetLink}</Link>
              </p>
              <p className="mt-2" data-testid="delete-account-no-access">{noAccess}</p>
            </section>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{d.deletedTitle}</h2>
              <ul className="list-disc pl-5 space-y-1">
                {d.deleted.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{d.keptTitle}</h2>
              <ul className="list-disc pl-5 space-y-1">
                {d.kept.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>

            <section>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">{d.limitsTitle}</h2>
              <p>{d.limits}</p>
            </section>

            <p>
              <Link href="/privacy" className="text-blue-600 hover:underline">{d.privacyLinkLabel} →</Link>
            </p>
          </div>

          <Link href="/" className="inline-block mt-6 text-sm text-blue-600 hover:underline">
            ← {d.back}
          </Link>
        </div>
      </div>
    </PublicShell>
  );
}
