import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { GraduationCap, LayoutDashboard, LogOut } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { SidebarAvatar } from '@/components/SidebarAvatar';
import { prisma } from '@/lib/prisma';

export default async function CompanyLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) redirect('/auth/signin');
  if (session.user.role !== 'COMPANY' && session.user.role !== 'ADMIN') redirect('/');

  const { locale, t } = await getServerDictionary();
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { avatarUrl: true } });

  return (
    <ResponsiveShell
      sidebar={
        <aside className="w-64 h-full bg-white border-r border-gray-200 flex flex-col">
          <div className="p-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <GraduationCap className="h-7 w-7 text-blue-600" />
              <span className="font-bold text-gray-900">InternshipCRM</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">{t.panel.company}</p>
          </div>

          <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
            <Link
              href="/company"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
            >
              <LayoutDashboard className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
              {t.nav.dashboard}
            </Link>
          </nav>

          <div className="p-4 border-t border-gray-200">
            <Link href="/account" title={t.account.nav} className="flex items-center gap-3 mb-3 px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors">
              <SidebarAvatar avatarUrl={me?.avatarUrl} name={session.user.name} fallback="C" className="bg-indigo-100 text-indigo-700" />
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
            <div className="mt-3 px-3">
              <LanguageSwitcher current={locale} />
            </div>
          </div>
        </aside>
      }
    >
      {children}
    </ResponsiveShell>
  );
}
