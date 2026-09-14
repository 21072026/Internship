import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { RoleShell } from '@/components/RoleShell';

export default async function TodosLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  // The callbackUrl is what makes the manifest's "To-dos" shortcut (#2084) land
  // here after signing in, instead of on the role's home page. RoleShell's own
  // sign-in redirect doesn't carry one (#2358 dropped this route's dedicated
  // check in favor of RoleShell's generic one), so check here first.
  if (!session) redirect('/auth/signin?callbackUrl=/todos');

  return <RoleShell>{children}</RoleShell>;
}
