import Link from 'next/link';
import { getServerDictionary } from '@/i18n/server';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';

// Public privacy notice — structured to cover the information GDPR Art. 13
// requires at the point of collection (controller, purposes, legal basis,
// recipients, retention, rights, withdrawal, complaint). The accepted version
// (PRIVACY_POLICY_VERSION) is recorded per user at registration.
export default async function PrivacyPage() {
  const { t } = await getServerDictionary();
  const p = t.privacy;

  const sections: { title: string; body: string }[] = [
    { title: p.controllerTitle, body: p.controllerBody },
    { title: p.purposesTitle, body: p.purposesBody },
    { title: p.legalBasisTitle, body: p.legalBasisBody },
    { title: p.recipientsTitle, body: p.recipientsBody },
    { title: p.retentionTitle, body: p.retention },
    { title: p.rightsTitle, body: p.rights },
    { title: p.contactTitle, body: p.contactBody },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 py-12 px-4">
      <div className="max-w-2xl mx-auto bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8">
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
        </div>

        <Link href="/" className="inline-block mt-8 text-sm text-blue-600 hover:underline">
          ← {p.back}
        </Link>
      </div>
    </div>
  );
}
