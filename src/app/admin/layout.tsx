import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { AdminShell } from './AdminShell';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/auth/signin');
  }

  if (session.user.role !== 'ADMIN') {
    redirect('/');
  }

  return (
    <AdminShell userName={session.user.name} userEmail={session.user.email}>
      {children}
    </AdminShell>
  );
}
