import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { NewsletterUnsubscribe } from '@/components/NewsletterUnsubscribe';

export const dynamic = 'force-dynamic';

/**
 * The page the newsletter footer's unsubscribe link points at (#1469).
 *
 * Public: it has to work months later, on a phone, without a login — asking
 * someone to remember a password before they can stop receiving mail is how you
 * end up mailing people who wanted out, and a reader who cannot leave presses
 * the spam button instead. The page only renders a button; the withdrawal
 * itself is a POST, so a mail client prefetching the link cannot act on
 * anyone's behalf.
 */
export default async function NewsletterUnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const { t } = await getServerDictionary();
  const n = t.newsletter;

  return (
    <PublicShell>
      <div className="mx-auto my-16 max-w-lg px-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{n.unsubTitle}</h1>
          {token ? (
            <>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{n.unsubBody}</p>
              <NewsletterUnsubscribe
                token={token}
                labels={{
                  button: n.unsubButton,
                  done: n.unsubDone,
                  doneHint: n.unsubDoneHint,
                  failed: n.unsubFailed,
                  resubscribe: n.unsubResubscribe,
                  resubscribed: n.unsubResubscribed,
                }}
              />
            </>
          ) : (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{n.unsubNoToken}</p>
          )}
        </div>
      </div>
    </PublicShell>
  );
}
