'use client';

import { Check, Compass, Trophy } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { pipelineGuidance, onPathKeys } from '@/lib/pipeline';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { useT, useLocale } from '@/i18n/client';

// Key achievement stages that warrant a milestone banner
// (EPIC: achievements / milestone recognition, roadmap #370). Canonical keys +
// any tenant stage flagged terminal (handled below).
const MILESTONE_STAGES = new Set([
  'INTERNSHIP_STARTING_300',
  'INTERNSHIP_IN_PROGRESS_450',
  'INTERNSHIP_COMPLETED_490',
  'HIRED_660',
  'EMPLOYED_700',
]);

export function JourneyTracker({ status }: { status: string }) {
  const t = useT();
  const locale = useLocale();
  const stages = useResolvedStages();
  const label = useStageLabel();
  // The happy-path milestones (excludes off-path); derived from the tenant's
  // resolved stages so custom pipelines render correctly (defaults unchanged).
  const PATH = onPathKeys(stages);
  const offPath = stages.find((s) => s.key === status)?.isOffPath ?? false;
  const idx = PATH.indexOf(status);
  const pct = idx >= 0 ? Math.round(((idx + 1) / PATH.length) * 100) : 0;
  const next = idx >= 0 && idx < PATH.length - 1 ? PATH[idx + 1] : null;
  const guidance = !offPath ? pipelineGuidance(status, locale) : null;
  // Milestone: a canonical milestone key, or any tenant stage marked terminal.
  const isMilestone = MILESTONE_STAGES.has(status) || (stages.find((s) => s.key === status)?.isTerminal ?? false);

  return (
    <Card>
      <CardHeader><CardTitle>{t.portal.journey.title}</CardTitle></CardHeader>

      {/* Milestone achievement banner for key stages */}
      {isMilestone && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-yellow-200 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-950/30 px-3 py-2.5">
          <Trophy className="h-4 w-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
          <div>
            <p className="text-xs font-semibold text-yellow-800 dark:text-yellow-200">{t.portal.journey.milestoneReached}</p>
            <p className="text-sm text-yellow-900 dark:text-yellow-100 mt-0.5">{label(status)}</p>
          </div>
        </div>
      )}

      {offPath ? (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          {label(status)}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="font-semibold text-gray-900 dark:text-gray-100">{label(status)}</span>
            <span className="text-gray-400 dark:text-gray-500">{pct}%</span>
          </div>
          <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden mb-4">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
          </div>

          {guidance && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 px-3 py-2.5">
              <Compass className="h-4 w-4 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-blue-800 dark:text-blue-200">{t.portal.journey.whatNow}</p>
                <p className="text-sm text-blue-900 dark:text-blue-100 mt-0.5">{guidance}</p>
              </div>
            </div>
          )}

          {next && <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">{t.portal.journey.next}: {label(next)}</p>}

          <ol className="space-y-1.5">
            {PATH.map((s, i) => {
              const done = idx >= 0 && i < idx;
              const current = i === idx;
              return (
                <li key={s} className="flex items-center gap-2 text-sm">
                  <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] ${
                    done ? 'bg-green-500 text-white' : current ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500'
                  }`}>
                    {done ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <span className={current ? 'font-medium text-gray-900 dark:text-gray-100' : done ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-600'}>
                    {label(s)}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Card>
  );
}
