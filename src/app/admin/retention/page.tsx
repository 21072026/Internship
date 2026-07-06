import Link from 'next/link';
import { getRetentionReview, getRetentionMonths, RETENTION_GRACE_DAYS } from '@/lib/retention';
import { getServerDictionary } from '@/i18n/server';
import { formatDate } from '@/lib/relativeTime';

// Admin retention review (GDPR Art. 5(1)(e)): candidates whose consent has
// passed the retention limit. "overdue" ones (past the grace period without
// renewal) should be reviewed for erasure — deletion stays a manual admin
// action (via the candidate's danger zone), never automatic.
export default async function AdminRetentionPage() {
  const { t, locale } = await getServerDictionary();
  const r = t.retentionAdmin;
  const [items, months] = await Promise.all([getRetentionReview(), getRetentionMonths()]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{r.title}</h1>
        <p className="text-gray-500 mt-1">{r.subtitle.replace('{months}', String(months)).replace('{grace}', String(RETENTION_GRACE_DAYS))}</p>
      </div>

      {items.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-10 text-center text-gray-400">
          {r.none}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">{r.colName}</th>
                <th className="px-4 py-3 font-medium">{r.colConsent}</th>
                <th className="px-4 py-3 font-medium">{r.colMonths}</th>
                <th className="px-4 py-3 font-medium">{r.colStatus}</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.userId} className="border-b border-gray-100 dark:border-gray-800/60 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{it.fullName}</div>
                    <div className="text-xs text-gray-400">{it.email}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {it.consentAt ? formatDate(it.consentAt, locale) : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{it.monthsSinceConsent ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        it.status === 'overdue'
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                      }`}
                    >
                      {it.status === 'overdue' ? r.statusOverdue : r.statusDue}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/candidates/${it.userId}`} className="text-blue-600 hover:underline">
                      {r.review} →
                    </Link>
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
