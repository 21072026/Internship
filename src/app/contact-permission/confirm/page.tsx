import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { ContactPermissionAction } from '@/components/ContactPermissionAction';

export const dynamic = 'force-dynamic';

/**
 * Where the confirmation mail's "yes" link lands (#2577). Public — the reader
 * filled in a form, they have no account. The page only renders a button; the
 * confirmation is its POST, so a mail scanner opening the link confirms
 * nothing. docs/contact-permission.md § Double opt-in.
 */
export default async function ContactPermissionConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const { t } = await getServerDictionary();
  const c = t.contactPermissionPage;
  return (
    <PublicShell>
      <div className="mx-auto my-16 max-w-lg px-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-900">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{c.confirmTitle}</h1>
          {token ? (
            <>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{c.confirmBody}</p>
              <ContactPermissionAction
                token={token}
                action="confirm"
                labels={{ button: c.confirmButton, done: c.confirmed, doneHint: c.confirmedHint, failed: c.failed, refused: c.refused }}
              />
            </>
          ) : (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{c.noToken}</p>
          )}
        </div>
      </div>
    </PublicShell>
  );
}
