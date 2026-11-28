'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, CalendarClock, Clock, HelpCircle, Hourglass, X } from 'lucide-react';
import { useT } from '@/i18n/client';

// "What do the badges mean?" on the board (#3977): the cards carry three
// clocks — days in the stage (StageClockChip, red past the stage deadline),
// the follow-up day (FollowUpChip) and, on the sales board, the trial end
// (TrialEndChip) — and nothing on the screen said which is which. A small
// panel, opened from the board header, says it with a miniature of each badge.
// Its open/closed state is a per-browser convenience (localStorage, guarded).

const STORAGE_KEY = 'board-legend-open';

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(open: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? '1' : '0');
  } catch {
    /* private window, blocked storage: the panel still works for this page */
  }
}

const CHIP = 'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium';

export function BoardLegendButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="board-legend"
      data-testid="board-legend-toggle"
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-gray-600 hover:text-blue-700 dark:text-gray-300 dark:hover:text-blue-300"
    >
      <HelpCircle className="h-4 w-4" aria-hidden />
      {t.boardLegend.toggle}
    </button>
  );
}

export function useBoardLegend() {
  const [open, setOpen] = useState(false);
  // After hydration only: the server renders it closed.
  useEffect(() => setOpen(readOpen()), []);
  const toggle = () =>
    setOpen((prev) => {
      writeOpen(!prev);
      return !prev;
    });
  return { open, toggle };
}

export function BoardLegend({ open, onClose, trial }: { open: boolean; onClose: () => void; trial: boolean }) {
  const t = useT();
  const L = t.boardLegend;
  if (!open) return null;
  const row = (badge: ReactNode, text: string, testId: string) => (
    <li className="flex items-start gap-3" data-testid={testId}>
      <span className="mt-0.5 flex w-24 shrink-0 justify-start">{badge}</span>
      <span className="text-sm text-gray-700 dark:text-gray-200">{text}</span>
    </li>
  );
  return (
    <section
      id="board-legend"
      aria-label={L.title}
      data-testid="board-legend"
      className="mb-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{L.title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={L.close}
          data-testid="board-legend-close"
          className="rounded p-1 text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <ul className="space-y-2.5">
        {row(
          <span className={`${CHIP} border-gray-200 bg-gray-50 text-gray-500`}>
            <Clock className="h-3 w-3" aria-hidden />
            {t.stageClock.chip.replace('{n}', '6')}
          </span>,
          L.stageDays,
          'board-legend-stage-days',
        )}
        {row(
          <span className={`${CHIP} border-red-200 bg-red-50 text-red-700`}>
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {t.stageClock.chip.replace('{n}', '8')}
          </span>,
          L.stageOverdue,
          'board-legend-stage-overdue',
        )}
        {row(
          <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
            <CalendarClock className="h-3 w-3" aria-hidden />
            {L.followUpSample}
          </span>,
          L.followUp,
          'board-legend-follow-up',
        )}
        {trial &&
          row(
            <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
              <Hourglass className="h-3 w-3" aria-hidden />
              {t.trialEnd.daysLeft.replace('{d}', '21')}
            </span>,
            L.trialEnd,
            'board-legend-trial',
          )}
      </ul>
    </section>
  );
}
