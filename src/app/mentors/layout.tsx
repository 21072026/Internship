import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { roleHome } from '@/lib/roleHome';

// The mentor directory (#938, story #900) is part of the mentee↔mentor
// matching flow, so it is for mentees, mentors and admins only — COMPANY and
// SOURCE are bounced to their own home (they have separately-consented
// surfaces like the talent pool). Lives outside the role shells, like
// /messages and /todos.
export default async function MentorsLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  if (session.user.role === 'COMPANY' || session.user.role === 'SOURCE') {
    redirect(roleHome(session.user.role));
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto max-w-6xl p-4 lg:p-8">
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
