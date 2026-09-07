'use client';

// The mentor-facing stage clock (#1724).
//
// "How long has this person been stuck here" is the most useful number on a
// pipeline board and it was on none of the mentor's screens — only in the
// ADMIN-only aging report. This chip is that number, in the tone of a queue
// that is aging: neutral by default, red once the organisation's own stage
// deadline has passed.
//
// The mentee sees the same clock in the portal WITHOUT any of that — see
// JourneyTracker. Do not reuse this component there.

import { AlertTriangle, Clock } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { useResolvedStages } from '@/lib/pipelineStagesClient';
import { formatDate } from '@/lib/relativeTime';
import { stageClockTone, type StageClockTone } from '@/lib/stageClock';

// bg-*-50 + text-*-700: globals.css already rescues exactly that pairing from
// dark-on-dark under html.dark (the compound overrides added in #503/#658), so
// no per-element dark: utility is needed here.
const TONE_CLASS: Record<StageClockTone, string> = {
  normal: 'text-gray-500 bg-gray-50 border-gray-200',
  overdue: 'text-red-700 bg-red-50 border-red-200',
};

export function StageClockChip({
  daysInStage,
  stageDeadline,
  pipelineStatus,
  relationStatus,
  paused,
  testId,
  className = '',
}: {
  daysInStage: number | null | undefined;
  stageDeadline?: string | null;
  pipelineStatus: string;
  /**
   * The relation's own status. A COMPLETED mentorship has no running clock —
   * counting the days since a finished relation last moved is a number nobody
   * can act on, and a stale deadline on it would render red forever. Same rule
   * the aging report applies by only measuring ACTIVE relations.
   */
  relationStatus?: string | null;
  /**
   * The mentee is in the re-engagement pool (#834) — "we'll write in
   * September". Served by the API, never derived here: the pool date lives on
   * the User. A paused clock still shows the days, it just never turns red, so
   * the mentor is not chased about somebody they were told to leave alone —
   * the same exclusion the admin aging report applies to its breach list.
   */
  paused?: boolean;
  testId?: string;
  className?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const stages = useResolvedStages();

  // An older payload (or a relation the API could not date) simply has no
  // clock — render nothing rather than a confident "0d".
  if (daysInStage == null) return null;
  if (relationStatus && relationStatus !== 'ACTIVE') return null;

  const tone = stageClockTone({ stageDeadline, pipelineStatus, paused }, stages);
  const days = String(daysInStage);
  const text = daysInStage === 0 ? t.stageClock.chipToday : t.stageClock.chip.replace('{n}', days);
  const title =
    tone === 'overdue' && stageDeadline
      ? t.stageClock.chipTitleOverdue.replace('{n}', days).replace('{date}', formatDate(stageDeadline, locale))
      : daysInStage === 0
        ? t.stageClock.chipTitleToday
        : t.stageClock.chipTitle.replace('{n}', days);

  const Icon = tone === 'overdue' ? AlertTriangle : Clock;

  return (
    <span
      data-testid={testId}
      data-stage-clock-tone={tone}
      title={title}
      // The visible text is an abbreviation ("12d"); screen readers get the
      // sentence, which is also what the tooltip says.
      aria-label={title}
      className={`inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${TONE_CLASS[tone]} ${className}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {text}
    </span>
  );
}
