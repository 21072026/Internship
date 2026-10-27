import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { roleHome } from '@/lib/roleHome';

// Notification history is available to any authenticated role.
export default async function NotificationsLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  // callbackUrl: the manifest's "Notifications" shortcut (#2084) must survive
  // the sign-in redirect and land back here.
  if (!session) redirect('/auth/signin?callbackUrl=/notifications');

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* pb-24: room below the last notification row for the floating
          feedback button (FeedbackWidget), which otherwise sits on top of a
          full-width row at the end of the list on a phone (#3059). */}
      <div className="max-w-3xl mx-auto p-4 pb-24 lg:p-8 lg:pb-24">
        <Link
          href={roleHome(session.user.role)}
          className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          {session.user.name ?? 'Back'}
        </Link>
        {children}
      </div>
    </div>
  );
}
