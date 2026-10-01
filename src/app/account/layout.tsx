import { NO_INDEX } from '@/lib/pageMetadata';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { roleHome } from '@/lib/roleHome';

// Signed-in area: never in a search result (#1376).
export const metadata = NO_INDEX;

// Standalone settings page available to every authenticated role.
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto p-4 lg:p-8">
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
