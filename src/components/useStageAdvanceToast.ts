'use client';

import { useCallback } from 'react';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { useStageLabel } from '@/lib/pipelineStagesClient';

/** What POST /api/interactions answers when a first contact moved the lead on (#3746). */
export interface StageAdvance {
  from: string;
  to: string;
}

/** `stageAdvance` off a POST /api/interactions response body, or null. */
export function stageAdvanceFrom(body: unknown): StageAdvance | null {
  const advance = (body as { stageAdvance?: StageAdvance | null } | null)?.stageAdvance;
  return advance && typeof advance.from === 'string' && typeof advance.to === 'string' ? advance : null;
}

/**
 * The one "moved to <stage> — Undo" toast after a logged interaction moved a
 * lead on (#3746), shared by the interaction form and the click-to-call
 * question (#3748) so the two can never drift. Undo moves the record back through
 * the same stage write path a board drag uses (PUT /api/mentorship/[id]);
 * `onChanged` re-reads the page after it.
 */
export function useStageAdvanceToast() {
  const t = useT();
  const toast = useToast();
  const stageLabel = useStageLabel();
  return useCallback(
    (relationId: string, advance: StageAdvance, onChanged: () => void) => {
      toast(t.logInteraction.stageAdvanced.replace('{stage}', stageLabel(advance.to)), 'success', {
        label: t.logInteraction.undo,
        onClick: async () => {
          const undone = await fetch(`/api/mentorship/${relationId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pipelineStatus: advance.from }),
          }).catch(() => null);
          if (undone?.ok) onChanged();
          else toast(t.logInteraction.undoFailed, 'error');
        },
      });
    },
    [t, toast, stageLabel],
  );
}
