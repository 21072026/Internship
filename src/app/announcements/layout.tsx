import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { roleHome } from '@/lib/roleHome';
import { I18nScope } from '@/i18n/scope';

// Announcement history is available to any authenticated role.
async function AnnouncementsLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="max-w-3xl mx-auto p-4 lg:p-8">
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

// The segment's dictionary namespaces wrap the WHOLE layout, its own chrome
// included (#2987, src/i18n/scope.tsx).
export default function ScopedAnnouncementsLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nScope scope="announcements">
      <AnnouncementsLayout>{children}</AnnouncementsLayout>
    </I18nScope>
  );
}
