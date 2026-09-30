import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { ContactPermissionAction } from '@/components/ContactPermissionAction';

export const dynamic = 'force-dynamic';

/**
 * Where the confirmation mail's "do not e-mail me" link lands (#2577). Public,
 * never expires, one press. The withdrawal is the button's POST, so a mail
 * scanner opening the link withdraws nothing. docs/contact-permission.md.
 */
export default async function ContactPermissionOptOutPage({
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
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{c.optOutTitle}</h1>
          {token ? (
            <>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{c.optOutBody}</p>
              <ContactPermissionAction
                token={token}
                action="opt-out"
                labels={{ button: c.optOutButton, done: c.optedOut, failed: c.failed, refused: c.failed }}
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
