'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShieldCheck, GraduationCap, Sprout } from 'lucide-react';
import { useT } from '@/i18n/client';
import { counterpartPath, modeOf, type AppMode } from '@/lib/appMode';

// View switch, pinned above the account menu in every shell the account can
// reach. It started as an admin↔mentor switch — letting an admin who also
// mentors see the app the way their mentors do — and now carries the mentee
// portal too (#1141), because someone who mentors can also be mentored. The
// active segment doubles as a "where am I" marker: a shell used to be reachable
// only by following a link (e.g. a notification), which made the whole layout
// appear to change for no visible reason.
//
// `modes` is decided server-side (see `lib/dualRole.ts`) and is empty when the
// account has only one shell — the switcher renders nothing at all rather than
// a one-button group.
const STYLES: Record<AppMode, { icon: typeof ShieldCheck; active: string }> = {
  admin: { icon: ShieldCheck, active: 'text-blue-700 dark:text-blue-300' },
  mentor: { icon: GraduationCap, active: 'text-green-700 dark:text-green-300' },
  mentee: { icon: Sprout, active: 'text-purple-700 dark:text-purple-300' },
};

export function ModeSwitcher({ modes }: { modes: AppMode[] }) {
  const t = useT();
  const pathname = usePathname();
  const current = modeOf(pathname) ?? modes[0];

  if (modes.length < 2) return null;

  return (
    <div className="px-4 pt-2" data-testid="mode-switcher">
      <p id="mode-switch-label" className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
        {t.modeSwitch.label}
      </p>
      <div
        role="group"
        aria-labelledby="mode-switch-label"
        style={{ gridTemplateColumns: `repeat(${modes.length}, minmax(0, 1fr))` }}
        className="grid gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1"
      >
        {modes.map((mode) => {
          const { icon: Icon, active } = STYLES[mode];
          const isActive = current === mode;
          const label = t.modeSwitch[mode];
          const classes = `flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
            isActive
              ? `bg-white dark:bg-gray-700 shadow-sm ${active}`
              : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
          }`;

          // The active segment is inert on purpose: it is a state indicator, and
          // a link back to the page you are already on is a dead control.
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
      {(current === 'mentor' || current === 'mentee') && (
        <p className="px-1 pt-1.5 text-[11px] leading-snug text-gray-600 dark:text-gray-400">
          {current === 'mentor' ? t.modeSwitch.mentorHint : t.modeSwitch.menteeHint}
        </p>
      )}
    </div>
  );
}
