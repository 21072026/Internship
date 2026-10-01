import { NO_INDEX } from '@/lib/pageMetadata';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { roleHome } from '@/lib/roleHome';
import { RoleShell } from '@/components/RoleShell';

// Signed-in area: never in a search result (#1376).
export const metadata = NO_INDEX;

export default async function MentorsLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  if (session.user.role === 'COMPANY' || session.user.role === 'SOURCE') {
    redirect(roleHome(session.user.role));
  }

  return <RoleShell>{children}</RoleShell>;
}
