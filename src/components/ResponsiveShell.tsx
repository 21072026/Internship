'use client';

import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { EmailVerificationBanner } from '@/components/EmailVerificationBanner';
import { ImpersonationBanner } from '@/components/ImpersonationBanner';
import { NotificationBell } from '@/components/NotificationBell';
import { MessagesButton } from '@/components/MessagesButton';
import { BetaBadge } from '@/components/BetaBadge';

// App shell: sidebar is a static column on desktop and an off-canvas drawer
// (with a hamburger top bar) on mobile.
export function ResponsiveShell({
  sidebar,
  children,
  headerExtra,
  brand,
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  headerExtra?: React.ReactNode;
  // White-label wordmark for the mobile top bar (#546); falls back to the
  // product name when not provided.
  brand?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 lg:flex">
      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-30 flex items-center justify-between bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 h-14 px-4">
        {brand ?? <span className="font-bold text-gray-900 dark:text-gray-100">InternshipCRM</span>}
        <BetaBadge className="ml-2" />
        <div className="flex items-center gap-1">
          <MessagesButton />
          <NotificationBell />
          <button onClick={() => setOpen(true)} aria-label="Open menu" className="p-2 -mr-2 text-gray-600 hover:text-gray-900">
            <Menu className="h-6 w-6" />
          </button>
        </div>
      </div>

      {/* Overlay (mobile only) */}
      {open && (
        <div className="fixed inset-0 bg-black/40 z-40 lg:hidden" onClick={() => setOpen(false)} aria-hidden />
      )}

      {/* Sidebar: drawer on mobile, sticky column on desktop */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-64 transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:z-auto lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <button
          onClick={() => setOpen(false)}
          aria-label="Close menu"
          className="lg:hidden absolute top-3 right-3 z-10 p-1 text-gray-500 hover:text-gray-800"
        >
          <X className="h-5 w-5" />
        </button>
        {/* Close the drawer only when a navigation link is tapped — NOT on any
            click. A blanket handler also caught the account-menu toggle button,
            closing the whole drawer before its popover (with sign-out) could
            show, so mobile users couldn't reach sign-out. Buttons (account
            toggle, theme/language/font-size) now keep the drawer open. */}
        <div
          className="h-full"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('a')) setOpen(false);
          }}
        >
          {sidebar}
        </div>
      </div>

      <main id="main-content" className="flex-1 overflow-auto min-w-0">
        {/* Desktop-only top strip for search + notifications */}
        <div className="hidden lg:flex items-center justify-end gap-3 px-8 pt-4 no-print">
          {headerExtra}
          <MessagesButton />
          <NotificationBell />
        </div>
        <div className="p-4 lg:p-8 lg:pt-2">
          <ImpersonationBanner />
          <EmailVerificationBanner />
          {children}
        </div>
      </main>
    </div>
  );
}
