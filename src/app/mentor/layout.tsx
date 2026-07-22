import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BetaBadge } from '@/components/BetaBadge';
import { AccountMenu } from '@/components/AccountMenu';
import { LayoutDashboard, Columns3, Users, BookOpen, Mail, CalendarClock, CalendarRange, CalendarDays, FolderGit2, Activity, BarChart3 } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { APP_VERSION } from '@/lib/version';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { BrandWordmark } from '@/components/BrandWordmark';
import { InstallAppButton } from '@/components/InstallAppButton';
import { prisma } from '@/lib/prisma';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';

export default async function MentorLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/auth/signin');
  }

  if (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN') {
    redirect('/');
  }

  const { locale, t } = await getServerDictionary();
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { avatarUrl: true, twoFactorEnabled: true } });

  // Auth hardening: hold in-scope roles at the 2FA setup gate until enabled.
  // Skipped while impersonating (the admin behind it is already authenticated).
  if (!session.user.impersonatorId && !me?.twoFactorEnabled && (await is2faRequiredFor(session.user.role))) {
    redirect('/security-setup');
  }

  return (
    <ResponsiveShell
      brand={<BrandWordmark />}
      sidebar={
        <aside className="w-64 h-full bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <BrandWordmark />
            <BetaBadge />
          </div>
          <p className="text-xs text-gray-500 mt-1">{t.panel.mentor}</p>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
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
            href="/mentor/projects"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <FolderGit2 className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.projects}
          </Link>
          <Link
            href="/mentor/interactions"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <BookOpen className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.interactionLogs}
          </Link>
          <Link
            href="/mentor/email"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <Mail className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.email}
          </Link>
          <Link
            href="/mentor/meetings"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <CalendarClock className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.meetings}
          </Link>
          <Link
            href="/mentor/availability"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <CalendarRange className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.availability}
          </Link>
          <Link
            href="/mentor/calendar"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <CalendarDays className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.calendar}
          </Link>
          <Link
            href="/mentor/mentee-activity"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <Activity className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.menteeActivity}
          </Link>
          <Link
            href="/mentor/analytics"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <BarChart3 className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {t.nav.analytics}
          </Link>
          <InstallAppButton />
        </nav>

        <AccountMenu
          name={session.user.name}
          email={session.user.email}
          avatarUrl={me?.avatarUrl}
          fallback="M"
          avatarClassName="bg-green-100 text-green-700"
          accountHref="/account"
          locale={locale}
          version={APP_VERSION}
        />
        </aside>
      }
    >
      {children}
    </ResponsiveShell>
  );
}
