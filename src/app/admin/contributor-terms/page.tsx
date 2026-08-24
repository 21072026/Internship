import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { buildAcceptanceReport } from '@/lib/contributorTermsReport';
import { ContributorTermsReport } from '@/components/admin/ContributorTermsReport';

export const dynamic = 'force-dynamic';

// The due-diligence screen (#1027): who accepted which contributor terms, when,
// and for what. The admin layout already gates on ADMIN; the check is repeated
// here because this page reads every person's acceptance record, and a route
// that leaks that must not depend on a layout staying the way it is today.
export default async function AdminContributorTermsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  if (session.user.role !== 'ADMIN') redirect('/');

  const { t, locale } = await getServerDictionary();
  const c = t.contributorTerms;
  const a = t.contributorTermsAdmin;
  const { rows, versions } = await buildAcceptanceReport();

  const keyList = Object.entries(versions);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{a.title}</h1>
        <p className="text-gray-500 mt-1">{a.subtitle}</p>
        <p className="mt-2 text-xs text-gray-400">
          {keyList.length === 0 ? (
            c.noneConfigured
          ) : (
            <>
              {a.inForce}: {keyList.map(([k, v]) => `${k} v${v}`).join(' · ')}
              {' · '}
              <Link href="/contributor-terms" className="text-blue-600 hover:underline">{a.readText}</Link>
            </>
          )}
        </p>
      </div>

      <ContributorTermsReport
        locale={locale}
        rows={rows.map((r) => ({ ...r, acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null }))}
        labels={{
          none: a.none,
          export: a.export,
          filterStatus: a.filterStatus,
          filterProject: a.filterProject,
          filterAll: a.filterAll,
          filterOpen: a.filterOpen,
          statusAccepted: a.statusAccepted,
          statusOutdated: a.statusOutdated,
          statusMissing: a.statusMissing,
          scopePlatform: c.scopePlatform,
          acceptedVersionShort: a.acceptedVersionShort,
          evidenceRecorded: a.evidenceRecorded,
          colName: a.colName,
          colEmail: a.colEmail,
          colRole: a.colRole,
          colScope: a.colScope,
          colTerms: a.colTerms,
          colCurrentVersion: a.colCurrentVersion,
          colAcceptedVersion: a.colAcceptedVersion,
          colAcceptedAt: a.colAcceptedAt,
          colStatus: a.colStatus,
          colEvidence: a.colEvidence,
        }}
      />
    </div>
  );
}
