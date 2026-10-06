import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { ReportUnsubscribe } from '@/components/ReportUnsubscribe';

export const dynamic = 'force-dynamic';

/**
 * Where a scheduled report's "unsubscribe" link lands (#1905). Public: the
 * recipient may have no account at all (a dean, a funder), and someone who
 * cannot leave in one press reaches for the spam button, which costs the whole
 * sending domain. The page only renders a button; the button POSTs.
 */
export default async function ReportUnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const { t } = await getServerDictionary();
  const S = t.reportSubscriptions;
  return (
    <PublicShell>
      <div className="mx-auto my-16 max-w-lg px-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{S.unsubTitle}</h1>
          {token ? (
            <>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{S.unsubBody}</p>
              <ReportUnsubscribe token={token} labels={{ button: S.unsubButton, done: S.unsubDone, failed: S.unsubFailed }} />
            </>
          ) : (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{S.unsubNoToken}</p>
          )}
        </div>
      </div>
    </PublicShell>
  );
}
