'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  GraduationCap,
  LayoutDashboard,
  Building2,
  Users,
  LogOut,
  Menu,
  X,
} from 'lucide-react';

type AdminShellProps = {
  children: React.ReactNode;
  userName?: string | null;
  userEmail?: string | null;
};

const navLinks = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/companies', label: 'Companies', icon: Building2 },
  { href: '/admin/candidates', label: 'Candidates', icon: Users },
  { href: '/admin/mentorship', label: 'Mentorships', icon: Users },
];

function SidebarContent({
  onNavigate,
  userName,
  userEmail,
}: {
  onNavigate?: () => void;
  userName?: string | null;
  userEmail?: string | null;
}) {
  return (
    <>
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <GraduationCap className="h-7 w-7 text-blue-600" />
          <span className="font-bold text-gray-900">InternshipCRM</span>
        </div>
        <p className="text-xs text-gray-500 mt-1">Admin Panel</p>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {navLinks.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
          >
            <item.icon className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="p-4 border-t border-gray-200">
        <div className="flex items-center gap-3 mb-3 px-3">
          <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
            <span className="text-blue-700 font-semibold text-sm">{userName?.[0] || 'A'}</span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{userName}</p>
            <p className="text-xs text-gray-500 truncate">{userEmail}</p>
          </div>
        </div>
        <Link
          href="/api/auth/signout"
          onClick={onNavigate}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </Link>
      </div>
    </>
  );
}

export function AdminShell({ children, userName, userEmail }: AdminShellProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const mobileSidebarClassName = `bg-white border-r border-gray-200 flex-col fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] shadow-2xl md:hidden ${
    isMenuOpen ? 'flex' : 'hidden'
  }`;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 md:flex">
      <div className="md:hidden sticky top-0 z-30 bg-white border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <GraduationCap className="h-6 w-6 text-blue-600 shrink-0" />
            <span className="font-semibold text-gray-900 truncate">InternshipCRM</span>
          </div>
          <button
            type="button"
            onClick={() => setIsMenuOpen((prev) => !prev)}
            className="p-2 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
            aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isMenuOpen}
            aria-controls="admin-mobile-menu"
          >
            {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {isMenuOpen && (
        <button
          type="button"
          aria-label="Close menu overlay"
          className="md:hidden fixed inset-0 z-30 bg-black/30"
          onClick={() => setIsMenuOpen(false)}
        />
      )}

      <aside
        id="admin-mobile-menu"
        aria-hidden={isMenuOpen ? undefined : true}
        className={mobileSidebarClassName}
      >
        <SidebarContent
          onNavigate={() => setIsMenuOpen(false)}
          userName={userName}
          userEmail={userEmail}
        />
      </aside>

      <aside className="hidden md:flex md:w-64 bg-white border-r border-gray-200 flex-col">
        <SidebarContent userName={userName} userEmail={userEmail} />
      </aside>

      <main className="flex-1 overflow-auto">
        <div className="p-4 md:p-8">{children}</div>
      </main>
    </div>
  );
}
