'use client';

import { AlertTriangle } from 'lucide-react';
import { useT } from '@/i18n/client';

// The red "overdue" pill on a board card (#2076). Whether a card IS overdue is
// the shared stage-clock rule (isStageOverdue, src/lib/stageClock.ts); this only
// draws the answer.
export function OverdueBadge() {
  const t = useT();
  return (
    <span className="flex-shrink-0 flex items-center gap-1 text-[10px] font-medium text-red-600 bg-red-50 border border-red-200 rounded-full px-1.5 py-0.5">
      <AlertTriangle className="h-3 w-3" />
      {t.adminBoard.overdue}
    </span>
  );
}
