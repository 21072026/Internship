import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { GraduationCap, LogOut } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { PortalNav } from '@/components/PortalNav';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { InstallAppButton } from '@/components/InstallAppButton';
import { SidebarAvatar } from '@/components/SidebarAvatar';
import { prisma } from '@/lib/prisma';

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/auth/signin');
  }

  if (session.user.role === 'ADMIN') {
    redirect('/admin');
  }

  if (session.user.role === 'MENTOR') {
    redirect('/mentor');
  }

  if (session.user.role === 'COMPANY') {
    redirect('/company');
  }

  const { locale, t } = await getServerDictionary();
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { avatarUrl: true } });

  return (
    <ResponsiveShell
      sidebar={
        <aside className="w-64 h-full bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <GraduationCap className="h-7 w-7 text-blue-600" />
            <span className="font-bold text-gray-900">InternshipCRM</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">{t.panel.mentee}</p>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          <PortalNav />
          <InstallAppButton />
        </nav>

        <div className="p-4 border-t border-gray-200">
          <Link href="/account" title={t.account.nav} className="flex items-center gap-3 mb-3 px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors">
            <SidebarAvatar avatarUrl={me?.avatarUrl} name={session.user.name} fallback="M" className="bg-purple-100 text-purple-700" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{session.user.name}</p>
              <p className="text-xs text-gray-500 truncate">{session.user.email}</p>
            </div>
          </Link>
          <Link
            href="/api/auth/signout"
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            <LogOut className="h-4 w-4" />
            {t.nav.signOut}
          </Link>
          <div className="mt-3 px-3 flex flex-col gap-2 items-start">
            <LanguageSwitcher current={locale} />
            <ThemeToggle />
          </div>
        </div>
        </aside>
      }
    >
      {children}
    </ResponsiveShell>
  );
}
