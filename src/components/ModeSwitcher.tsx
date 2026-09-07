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
//
// Contrast of the active pill — the three facts you would otherwise have to
// re-derive from globals.css, and the numbers they produce (#826, #1343).
//
// 1. `dark:!` rather than a plain `dark:` variant, because globals.css retints
//    the base utilities with FLAT rules — `html.dark .text-gray-700`,
//    `html[data-accent] .text-blue-200` — that score (0,2,1) and outrank
//    Tailwind's class-strategy `.dark .dark\:text-*` at (0,2,0). An unforced
//    `dark:` here is silently inert.
// 2. `html[data-accent]` is ALWAYS present (it defaults to "blue") and scores
//    the same as `html.dark`, so between those two source order decides — which
//    is why a `dark:` variant is the wrong layer for this and `!important` is
//    the right one.
// 3. The pill's own `bg-white dark:bg-gray-700` resolves to gray-900 (#111827)
//    in dark mode, NOT gray-700: `html.dark .bg-white` is (0,2,1) and outranks
//    `.dark .dark\:bg-gray-700` at (0,2,0). Same trap as (1), on the surface
//    instead of the text. Do not "fix" that by forcing the pill to gray-700 —
//    it lowers the pill-vs-track separation (1.42:1 as authored vs 1.72:1 as
//    rendered) and the label is fine either way (7.25:1 on gray-700).
//
// Measured pairs, all above the 4.5:1 that WCAG 1.4.3 asks of this 12px label:
//   dark  — blue-200/green-200/purple-200 on #111827: 12.5 / 14.6 / 13.0:1
//   light — accent-700 on white 5.02-6.98:1 across all six accents (green and
//           amber are the floor), green-700 5.02:1, purple-700 6.98:1
// e2e/contrast-1343.spec.ts pins this in the rendered document, both themes,
// all three modes; guessing here has cost two failed attempts before (#826).
const STYLES: Record<AppMode, { icon: typeof ShieldCheck; active: string }> = {
  admin: { icon: ShieldCheck, active: 'text-blue-700 dark:!text-blue-200' },
  mentor: { icon: GraduationCap, active: 'text-green-700 dark:!text-green-200' },
  mentee: { icon: Sprout, active: 'text-purple-700 dark:!text-purple-200' },
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
          //
          // Both arms carry `data-active` rather than leaving the state implicit
          // in `aria-current`, so a contrast spec can name the pill and its
          // unselected siblings separately without depending on the tag each
          // renders as (#1343).
          return isActive ? (
            <span
              key={mode}
              aria-current="page"
              data-testid="mode-switch-option"
              data-mode={mode}
              data-active="true"
              className={classes}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {label}
            </span>
          ) : (
            <Link
              key={mode}
              href={counterpartPath(pathname, mode)}
              title={t.modeSwitch.switchTo.replace('{mode}', label)}
              data-testid="mode-switch-option"
              data-mode={mode}
              data-active="false"
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
