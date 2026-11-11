import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { TeamsTabSignIn } from '@/components/embed/TeamsTabSignIn';

// The Teams tab's landing (#1954). Signed in already (the embed session):
// straight to the role home. Otherwise the tab signs itself in through Teams
// (TeamsTabSignIn) — or, outside Teams or for a member who has not linked
// their account, shows the "link your account" screen. Never an account.
export const dynamic = 'force-dynamic';

export default async function EmbedPage() {
  const session = await getServerSession(authOptions);
  if (session?.user) redirect('/embed/home');
  return (
    <main className="mx-auto max-w-lg p-6 text-sm text-gray-800 dark:text-gray-100">
      <TeamsTabSignIn />
    </main>
  );
}
