'use client';

import { ArrowRightLeft } from 'lucide-react';
import { useT } from '@/i18n/client';
import type { ResolvedStage } from '@/lib/pipelineStagesClient';

/**
 * The per-card stage picker — the touch and keyboard alternative to drag-and-drop
 * on both boards (#936). Native `<select>` on purpose: it opens the platform
 * picker on a phone and is keyboard-operable for free.
 *
 * It is drawn as an icon, not as a field: a full-width select under every card
 * cost a 44px row per card and repeated the name of the column the card already
 * sits in. The `<select>` itself is still there — transparent, stretched over the
 * icon — so the picker, the keyboard behaviour and the accessible name are the
 * native ones. Place it inside a flex row of the card (`ml-auto` pushes it right).
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
    <span
      title={t.board.moveTo}
      className="relative -my-1 ml-auto inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded text-gray-400 hover:text-gray-700 focus-within:text-gray-700 focus-within:ring-2 focus-within:ring-blue-300 md:h-7 md:w-7"
    >
      <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
      <select
        aria-label={t.board.moveTo}
        value={value}
        disabled={disabled}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          e.stopPropagation();
          onChange(e.target.value);
        }}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
      >
        {stages.map((s) => (
          <option key={s.key} value={s.key}>{s.label}</option>
        ))}
      </select>
    </span>
  );
}
