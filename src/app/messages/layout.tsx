import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { roleHome } from '@/lib/roleHome';

// Conversation threads are available to any authenticated participant.
export default async function MessagesLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');

  return (
    <div className="min-h-screen bg-gray-50">
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
