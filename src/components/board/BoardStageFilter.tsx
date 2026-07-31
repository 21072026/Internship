'use client';

import { useT } from '@/i18n/client';
import type { ResolvedStage } from '@/lib/pipelineStagesClient';

/**
 * Phone view of the board: instead of scrolling 13 columns sideways (only ~1.2 of
 * them fit at 390px), pick one stage and see its cards as a plain list (#936).
 * Counts are in the option labels so the distribution is still visible without
 * opening every stage.
 */
export function BoardStageFilter({
  stages,
  countFor,
  value,
  onChange,
}: {
  stages: ResolvedStage[];
  countFor: (stage: string) => number;
  value: string;
  onChange: (stage: string) => void;
}) {
  const t = useT();
  return (
    <label className="block mb-3">
      <span className="block text-xs font-medium text-gray-500 mb-1">{t.board.stageFilter}</span>
      <select
        data-testid="board-stage-filter"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
      >
        {stages.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label} ({countFor(s.key)})
          </option>
        ))}
      </select>
    </label>
  );
}
