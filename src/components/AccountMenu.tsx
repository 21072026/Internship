'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { LogOut, Settings, ChevronUp } from 'lucide-react';
import { SidebarAvatar } from '@/components/SidebarAvatar';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { VersionFooter } from '@/components/VersionFooter';
import { useT } from '@/i18n/client';
import type { Locale } from '@/i18n/config';

// Consolidated sidebar footer: the collapsed row shows just the user's identity
// (avatar + name + email) and a chevron; clicking opens an upward popover with
// the account link, sign-out, language + theme controls and the version. Keeps
// the footer from becoming a crowded stack of controls.
export function AccountMenu({
  name,
  email,
  avatarUrl,
  fallback,
  avatarClassName,
  accountHref,
  locale,
  version,
}: {
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  fallback: string;
  avatarClassName: string;
  accountHref: string;
  locale: Locale;
  version: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative p-4 border-t border-gray-200 dark:border-gray-800">
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-4 right-4 mb-2 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-lg p-2 z-50"
        >
          <Link
            href={accountHref}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <Settings className="h-4 w-4" />
            {t.account.nav}
          </Link>
          <Link
            href="/api/auth/signout"
            role="menuitem"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
          >
            <LogOut className="h-4 w-4" />
            {t.nav.signOut}
          </Link>
          <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
          <div className="flex items-center justify-between gap-2 px-3 py-1.5">
            <LanguageSwitcher current={locale} />
            <ThemeToggle />
          </div>
          <div className="px-3 pt-1">
            <VersionFooter version={version} />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.account.nav}
        className="flex items-center gap-3 w-full px-3 py-1.5 rounded-lg text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        <SidebarAvatar avatarUrl={avatarUrl} name={name} fallback={fallback} className={avatarClassName} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{name}</p>
          <p className="text-xs text-gray-500 truncate">{email}</p>
        </div>
        <ChevronUp className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
    </div>
  );
}
