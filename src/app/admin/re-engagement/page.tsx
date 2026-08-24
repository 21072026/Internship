import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { formatDate } from '@/lib/relativeTime';
import { resolveOrgId } from '@/lib/orgScope';
import { PoolRemoveButton } from '@/components/admin/PoolRemoveButton';

export const dynamic = 'force-dynamic';

// The re-engagement pool, soonest first (#834).
//
// Its own page rather than a third tab on /admin/candidates: "who are we
// writing to next" is a question asked on its own, on a different rhythm from
// browsing candidates, and these people were deliberately taken out of the
// aging report — giving them a place of their own is what keeps them visible
// rather than merely absent.
export default async function AdminReEngagementPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  if (session.user.role !== 'ADMIN') redirect('/');

  const { t, locale } = await getServerDictionary();
  const r = t.reEngagement;
  const orgId = resolveOrgId(session);

  const people = await prisma.user.findMany({
    where: { role: 'MENTEE', reEngageAt: { not: null }, ...(orgId ? { orgId } : {}) },
    orderBy: { reEngageAt: 'asc' },
    select: { id: true, fullName: true, email: true, reEngageAt: true, reEngageNote: true, reEngageNotifiedAt: true },
  });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{r.poolTab}</h1>
        <p className="text-gray-500 mt-1 max-w-3xl">{r.consentHint}</p>
      </div>

      {people.length === 0 ? (
        <div data-testid="pool-empty" className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-10 text-center text-gray-400">
          {r.poolEmpty}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <table className="w-full text-sm" data-testid="pool-table">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">{r.colWhen}</th>
                <th className="px-4 py-3 font-medium">{t.contributorTermsAdmin.colName}</th>
                <th className="px-4 py-3 font-medium">{r.colNote}</th>
                <th className="px-4 py-3 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} data-testid={`pool-row-${p.id}`} className="border-b border-gray-100 dark:border-gray-800/60 last:border-0">
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {formatDate(p.reEngageAt!, locale)}
                    {p.reEngageNotifiedAt && <span className="ml-2 text-xs text-green-600">· {r.notified}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{p.fullName}</div>
                    <div className="text-xs text-gray-400">{p.email}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{p.reEngageNote ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <PoolRemoveButton userId={p.id} label={r.remove} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
