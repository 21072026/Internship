'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShieldCheck, GraduationCap } from 'lucide-react';
import { useT } from '@/i18n/client';
import { counterpartPath, modeOf, type AppMode } from '@/lib/appMode';

// Admin-only view switch, pinned above the account menu in both shells: it lets
// an admin who also mentors see the app the way their mentors do (own mentees
// only, no org-wide tooling) instead of always working from the dense admin
// pages. The active segment doubles as a "where am I" marker — the mentor shell
// used to be reachable only by following a link (e.g. a notification), which
// made the whole layout appear to change for no visible reason.
const MODES: { mode: AppMode; icon: typeof ShieldCheck; active: string }[] = [
  { mode: 'admin', icon: ShieldCheck, active: 'text-blue-700 dark:text-blue-300' },
  { mode: 'mentor', icon: GraduationCap, active: 'text-green-700 dark:text-green-300' },
];

export function ModeSwitcher() {
  const t = useT();
  const pathname = usePathname();
  const current = modeOf(pathname) ?? 'admin';

  return (
    <div className="px-4 pt-2" data-testid="mode-switcher">
      <p id="mode-switch-label" className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {t.modeSwitch.label}
      </p>
      <div
        role="group"
        aria-labelledby="mode-switch-label"
        className="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1"
      >
        {MODES.map(({ mode, icon: Icon, active }) => {
          const isActive = current === mode;
          const label = t.modeSwitch[mode];
          const classes = `flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
            isActive
              ? `bg-white dark:bg-gray-700 shadow-sm ${active}`
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
          }`;

          // The active half is inert on purpose: it is a state indicator, and a
          // link back to the page you are already on is a dead control.
          return isActive ? (
            <span key={mode} aria-current="page" className={classes}>
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {label}
            </span>
          ) : (
            <Link
              key={mode}
              href={counterpartPath(pathname, mode)}
              title={t.modeSwitch.switchTo.replace('{mode}', label)}
              className={classes}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {label}
            </Link>
          );
        })}
      </div>
      {current === 'mentor' && (
        <p className="px-1 pt-1.5 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
          {t.modeSwitch.mentorHint}
        </p>
      )}
    </div>
  );
}
