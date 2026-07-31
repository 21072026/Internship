import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { roleHome } from '@/lib/roleHome';
import { MessagesShell } from '@/components/MessagesShell';

// Conversation threads are available to any authenticated participant.
// MessagesShell provides the mobile app shell (full-height frame + header with
// back/home) and the desktop document flow — see the comment in that file.
export default async function MessagesLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');

  return <MessagesShell homeHref={roleHome(session.user.role)}>{children}</MessagesShell>;
}
