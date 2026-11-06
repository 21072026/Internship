'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { outcomeStageKeysFrom } from '@/lib/pipeline';
import { useResolvedStages } from '@/lib/pipelineStagesClient';
import { useVertical } from '@/lib/verticalClient';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { EMPLOYMENT_ATTRIBUTIONS, type EmploymentAttribution } from '@/lib/placementKind';

// Whose outcome a hire is (#1507, the UI of #1503): asked before a relation
// moves into one of the tenant's hire stages, in the same shape as the
// drop-off reason dialog (#810). The answer decides whether the hire counts as
// a placement (src/lib/placement.ts); the server validates it with
// validateEmploymentAttribution(), this only makes sure it is asked.

/**
 * Does a move to `toStatus` need the attribution question? Only into the
 * tenant's own finished stages (the same `outcomeStageKeysFrom()` the server
 * reads), never in MARKETING (a sale is not a hire) and never for a coaching
 * pair, which is outside the hiring funnel.
 */
export function useNeedsAttribution(): (toStatus: string, kind?: string | null) => boolean {
  const stages = useResolvedStages();
  const vertical = useVertical();
  const finished = useMemo(() => new Set(outcomeStageKeysFrom(stages).finished), [stages]);
  return useCallback(
    (toStatus: string, kind?: string | null) => vertical !== 'MARKETING' && kind !== 'COACHING' && finished.has(toStatus),
    [vertical, finished],
  );
}

export interface EmploymentAttributionDialogProps {
  open: boolean;
  /** The target stage's display label, interpolated into the title. */
  stageLabel: string;
  loading?: boolean;
  onConfirm: (attribution: EmploymentAttribution) => void;
  onCancel: () => void;
}

export function EmploymentAttributionDialog({ open, stageLabel, loading = false, onConfirm, onCancel }: EmploymentAttributionDialogProps) {
  const t = useT();
  const a = t.employmentAttribution;
  const [choice, setChoice] = useState<EmploymentAttribution | ''>('');
  const dialogRef = useModalFocus<HTMLDivElement>(open, onCancel);

  useEffect(() => {
    if (open) setChoice('');
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="employment-attribution-title"
        data-testid="employment-attribution-dialog"
        tabIndex={-1}
        className="w-full max-w-sm rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="employment-attribution-title" className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">
          {a.dialogTitle.replace('{stage}', stageLabel)}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{a.dialogHint}</p>
        <fieldset className="space-y-2">
          <legend className="sr-only">{a.dialogTitle.replace('{stage}', stageLabel)}</legend>
          {EMPLOYMENT_ATTRIBUTIONS.map((value) => (
            <label key={value} className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
              <input
                type="radio"
                name="employment-attribution"
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
                data-testid={`employment-attribution-${value}`}
                className="mt-0.5"
              />
              <span>{a.options[value]}</span>
            </label>
          ))}
        </fieldset>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={loading} onClick={onCancel} data-testid="employment-attribution-cancel">
            {a.cancel}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={loading}
            disabled={loading || !choice}
            onClick={() => choice && onConfirm(choice)}
            data-testid="employment-attribution-confirm"
          >
            {a.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
