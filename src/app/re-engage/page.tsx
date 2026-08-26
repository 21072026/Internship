import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { ReEngageLeave } from '@/components/ReEngageLeave';

export const dynamic = 'force-dynamic';

// The landing page the "stop writing to me" link in the e-mail points at (#834).
// Public: the whole point is that it works months later without a login. The
// page only shows a button — the actual withdrawal is a POST, so a mail client
// prefetching the link cannot act on someone's behalf.
export default async function ReEngageLeavePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const { t } = await getServerDictionary();
  const r = t.reEngagement;

  return (
    <PublicShell>
      <div className="mx-auto my-16 max-w-lg px-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{r.leaveTitle}</h1>
          {token ? (
            <>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{r.leaveBody}</p>
              <ReEngageLeave token={token} labels={{ button: r.leaveButton, done: r.leaveDone, failed: r.leaveFailed }} />
            </>
          ) : (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{r.leaveNoToken}</p>
          )}
        </div>
      </div>
    </PublicShell>
  );
}
