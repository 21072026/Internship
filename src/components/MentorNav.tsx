'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, BarChart3, BookOpen, CalendarClock, CalendarDays, CalendarRange, ClipboardCheck, ClipboardList, Columns3, FolderGit2, Inbox, LayoutDashboard, Mail, User, UserPlus, Users } from 'lucide-react';
import { useT } from '@/i18n/client';

export function MentorNav() {
  const t = useT();
  const pathname = usePathname();
  const links = [
    { href: '/mentor', label: t.nav.dashboard, Icon: LayoutDashboard },
    { href: '/mentor/board', label: t.nav.board, Icon: Columns3 },
    { href: '/mentor/mentees', label: t.nav.myMentees, Icon: Users },
    { href: '/mentor/applications', label: t.nav.applications, Icon: Inbox },
    { href: '/mentor/invite', label: t.nav.inviteMentee, Icon: UserPlus },
    { href: '/mentor/profile', label: t.nav.myProfile, Icon: User },
    { href: '/mentor/projects', label: t.nav.projects, Icon: FolderGit2 },
    { href: '/todos', label: t.nav.todos, Icon: ClipboardList },
    { href: '/mentor/interactions', label: t.nav.interactionLogs, Icon: BookOpen },
    { href: '/mentor/email', label: t.nav.email, Icon: Mail },
    { href: '/mentor/meetings', label: t.nav.meetings, Icon: CalendarClock },
    { href: '/mentor/interview-requests', label: t.nav.interviewRequests, Icon: CalendarDays },
    { href: '/interviews', label: t.nav.interviewPanels, Icon: ClipboardCheck },
    { href: '/mentor/availability', label: t.nav.availability, Icon: CalendarRange },
    { href: '/mentor/calendar', label: t.nav.calendar, Icon: CalendarDays },
    { href: '/mentor/mentee-activity', label: t.nav.menteeActivity, Icon: Activity },
    { href: '/mentor/analytics', label: t.nav.analytics, Icon: BarChart3 },
  ];

  const isActive = (href: string) =>
    href === '/mentor' ? pathname === '/mentor' : pathname.startsWith(href);

  return (
    <>
      {links.map(({ href, label, Icon }) => {
        const active = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors group ${
              active
                ? 'bg-blue-50 text-blue-700 font-medium'
                : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700'
            }`}
          >
            <Icon className={`h-5 w-5 ${active ? 'text-blue-600' : 'text-gray-400 group-hover:text-blue-600'}`} />
            {label}
          </Link>
        );
      })}
    </>
  );
}
