import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { roleHome } from '@/lib/roleHome';

// The Teams tab's landing (#1954). Signed in (the embed session, or any
// session): who you are and the way to your home. Not signed in: the "link your
// account" screen — the tab never creates an account. The Teams SDK hand-off
// that signs the tab in on its own is the next slice; this page is what both
// ends of it show.
export const dynamic = 'force-dynamic';

export default async function EmbedPage() {
  const [session, dict] = await Promise.all([getServerSession(authOptions), getServerDictionary()]);
  const t = dict.t.embed;
  return (
    <main className="mx-auto max-w-lg p-6 text-sm text-gray-800 dark:text-gray-100">
      {session?.user ? (
        <>
          <h1 className="mb-2 text-lg font-semibold">{t.signedInTitle}</h1>
          <p className="mb-4" data-testid="embed-signed-in">{t.signedInAs.replace('{name}', session.user.name ?? session.user.email ?? '')}</p>
          <a className="text-blue-600 underline" href={roleHome(session.user.role)} target="_blank" rel="noopener noreferrer">
            {t.openApp}
          </a>
        </>
      ) : (
        <>
          <h1 className="mb-2 text-lg font-semibold">{t.linkTitle}</h1>
          <p className="mb-4" data-testid="embed-link">{t.linkBody}</p>
          <a className="text-blue-600 underline" href="/account" target="_blank" rel="noopener noreferrer">
            {t.linkCta}
          </a>
        </>
      )}
    </main>
  );
}
