'use client';

import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { EmailVerificationBanner } from '@/components/EmailVerificationBanner';

// App shell: sidebar is a static column on desktop and an off-canvas drawer
// (with a hamburger top bar) on mobile.
export function ResponsiveShell({
  sidebar,
  children,
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50 lg:flex">
      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-30 flex items-center justify-between bg-white border-b border-gray-200 h-14 px-4">
        <span className="font-bold text-gray-900">InternshipCRM</span>
        <button onClick={() => setOpen(true)} aria-label="Open menu" className="p-2 -mr-2 text-gray-600 hover:text-gray-900">
          <Menu className="h-6 w-6" />
        </button>
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
        {/* Close the drawer when a nav link is tapped */}
        <div className="h-full" onClick={() => setOpen(false)}>
          {sidebar}
        </div>
      </div>

      <main className="flex-1 overflow-auto min-w-0">
        <div className="p-4 lg:p-8">
          <EmailVerificationBanner />
          {children}
        </div>
      </main>
    </div>
  );
}
