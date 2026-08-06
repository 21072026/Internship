import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { roleHome } from '@/lib/roleHome';

// The to-do list belongs to the person, not to a role, so it lives outside the
// admin/mentor/portal shells — like /notifications and /messages (#1113).
export default async function TodosLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto max-w-3xl p-4 lg:p-8">
        <Link
          href={roleHome(session.user.role)}
          className="mb-6 inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          {session.user.name ?? 'Back'}
        </Link>
        {children}
      </div>
    </div>
  );
}
