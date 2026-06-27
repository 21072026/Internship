import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { GraduationCap, LayoutDashboard, Columns3, Users, BookOpen, LogOut } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

export default async function MentorLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/auth/signin');
  }

  if (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN') {
    redirect('/');
  }

  const { locale, t } = await getServerDictionary();

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <GraduationCap className="h-7 w-7 text-blue-600" />
            <span className="font-bold text-gray-900">InternshipCRM</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">{t.panel.mentor}</p>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          <Link
            href="/mentor"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <LayoutDashboard className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.dashboard}
          </Link>
          <Link
            href="/mentor/board"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <Columns3 className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.board}
          </Link>
          <Link
            href="/mentor/mentees"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <Users className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.myMentees}
          </Link>
          <Link
            href="/mentor/interactions"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <BookOpen className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.interactionLogs}
          </Link>
        </nav>

        <div className="p-4 border-t border-gray-200">
          <div className="flex items-center gap-3 mb-3 px-3">
            <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
              <span className="text-green-700 font-semibold text-sm">
                {session.user.name?.[0] || 'M'}
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{session.user.name}</p>
              <p className="text-xs text-gray-500 truncate">{session.user.email}</p>
            </div>
          </div>
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

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}
