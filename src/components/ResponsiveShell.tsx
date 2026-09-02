'use client';

import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { EmailVerificationBanner } from '@/components/EmailVerificationBanner';
import { NotificationBell } from '@/components/NotificationBell';
import { MessagesButton } from '@/components/MessagesButton';
import { BetaBadge } from '@/components/BetaBadge';
import { JoinMeetingPill } from '@/components/JoinMeetingPill';

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
      <div className="lg:hidden sticky top-0 z-30 flex items-center justify-between bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 h-14 px-2">
        {/* Keep enough room for the one-line wordmark and three 44px actions;
            the secondary environment badge returns at the sm breakpoint. */}
        <div className="flex items-center min-w-0">
          {brand ?? <span className="font-bold text-gray-900 dark:text-gray-100 truncate">InternshipCRM</span>}
          <BetaBadge className="ml-2 hidden flex-shrink-0 sm:inline-flex" />
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Only visible while a meeting is actually running (#51 follow-up). */}
          <JoinMeetingPill />
          <MessagesButton />
          <NotificationBell />
          {/* No negative margin: `-mr-2` pushed the icon 8px past the bar's px-4 and
              made the page 2px wider than a 320px phone (#936). */}
          <button onClick={() => setOpen(true)} aria-label="Open menu" className="inline-flex min-h-11 min-w-11 items-center justify-center text-gray-600 hover:text-gray-900">
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
        // Named so a11y-media-preferences.spec.ts can assert the drawer still
        // opens and closes under prefers-reduced-motion — the blanket rule in
        // globals.css collapses the 200ms transition, it must not disable the
        // state change itself (#2045).
        data-testid="mobile-drawer"
        data-open={open ? 'true' : 'false'}
        className={`fixed inset-y-0 left-0 z-50 w-64 transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:z-auto lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <button
          onClick={() => setOpen(false)}
          aria-label="Close menu"
          className="lg:hidden absolute top-1 right-1 z-10 inline-flex min-h-11 min-w-11 items-center justify-center text-gray-500 hover:text-gray-800"
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
          <JoinMeetingPill />
          <MessagesButton />
          <NotificationBell />
        </div>
        <div className="p-4 lg:p-8 lg:pt-2">
          {/* The impersonation banner is rendered app-wide in Providers — it has to
              show on the shell-less screens too (/messages, /account, ...). */}
          <EmailVerificationBanner />
          {children}
        </div>
      </main>
    </div>
  );
}
