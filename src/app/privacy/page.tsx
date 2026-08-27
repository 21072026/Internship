import Link from 'next/link';
import { getServerDictionary } from '@/i18n/server';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';
import { PublicShell } from '@/components/landing/PublicShell';
import { operatorIdentity } from '@/lib/imprint';

// The controller's identity is read from the deployment's env, which only
// exists at runtime — prerendering this page at build time would freeze the
// "no operator published" wording into the image (see src/lib/imprint.ts).
export const dynamic = 'force-dynamic';

// Public privacy notice — structured to cover the information GDPR Art. 13
// requires at the point of collection (controller, purposes, legal basis,
// recipients, retention, rights, withdrawal, complaint). The accepted version
// (PRIVACY_POLICY_VERSION) is recorded per user at registration.
export default async function PrivacyPage() {
  const { t } = await getServerDictionary();
  const p = t.privacy;

  // Art. 13(1)(a)/(b) wants a NAMED controller and a way to reach them. Until
  // #1396 both sentences were placeholders telling the reader that the operator
  // would fill them in before production use — on a deployment that had been
  // live for months. Now they carry the configured identity, and when a
  // deployment has published none the wording says that plainly instead of
  // promising it later.
  const operator = operatorIdentity();
  const controllerBody = operator ? p.controllerBody.replace('{operator}', operator.name) : p.controllerUnset;
  const contactBody = operator ? p.contactBody.replace('{email}', operator.email) : p.contactUnset;

  const sections: { title: string; body: string }[] = [
    { title: p.controllerTitle, body: controllerBody },
    { title: p.purposesTitle, body: p.purposesBody },
    { title: p.legalBasisTitle, body: p.legalBasisBody },
    { title: p.recipientsTitle, body: p.recipientsBody },
    { title: p.retentionTitle, body: p.retention },
    { title: p.rightsTitle, body: p.rights },
    { title: p.contactTitle, body: contactBody },
  ];

  return (
    <PublicShell>
      <div className="max-w-2xl mx-auto my-12 px-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">{p.title}</h1>
          <p className="text-xs text-gray-400 mb-6">
            {p.lastUpdatedLabel}: {PRIVACY_POLICY_VERSION}
          </p>

          <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">{p.intro}</p>

          <div className="space-y-5">
            {sections.map((s) => (
              <section key={s.title}>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">{s.title}</h2>
                <p className="text-sm text-gray-600 dark:text-gray-300">{s.body}</p>
              </section>
            ))}

            {/* Withdrawal + complaint are part of the "rights" disclosure. */}
            <p className="text-sm text-gray-600 dark:text-gray-300">{p.withdraw}</p>
            <p className="text-sm text-gray-600 dark:text-gray-300">{p.complaint}</p>

            <p className="text-sm">
              <Link href="/imprint" className="text-blue-600 hover:underline" data-testid="privacy-imprint-link">
                {p.imprintLink} →
              </Link>
            </p>
          </div>

          <Link href="/" className="inline-block mt-8 text-sm text-blue-600 hover:underline">
            ← {p.back}
          </Link>
        </div>
      </div>
    </PublicShell>
  );
}
