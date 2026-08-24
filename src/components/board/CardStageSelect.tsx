'use client';

import { useT } from '@/i18n/client';
import type { ResolvedStage } from '@/lib/pipelineStagesClient';

/**
 * The per-card stage picker — the touch and keyboard alternative to drag-and-drop
 * on both boards (#936). Native `<select>` on purpose: it opens the platform
 * picker on a phone and is keyboard-operable for free.
 *
 * Clicks are stopped from bubbling so choosing a stage does not also trigger the
 * card's navigate-on-click.
 */
export function CardStageSelect({
  stages,
  value,
  onChange,
  disabled,
}: {
  stages: ResolvedStage[];
  value: string;
  onChange: (stage: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <select
      aria-label={t.board.moveTo}
      value={value}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        onChange(e.target.value);
      }}
      className="mt-2 min-h-11 w-full rounded border border-gray-200 px-1.5 py-1 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-100"
    >
      {stages.map((s) => (
        <option key={s.key} value={s.key}>{s.label}</option>
      ))}
    </select>
  );
}
