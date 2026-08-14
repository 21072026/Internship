'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';
import { DROPOFF_REASON_CODES } from '@/lib/dropoffReasons';

export interface DropoffReasonDialogProps {
  open: boolean;
  // The target stage's display label, interpolated into the title.
  stageLabel: string;
  loading?: boolean;
  onConfirm: (reasonCode: string, reasonNote: string) => void;
  onCancel: () => void;
}

// Reason picker shown before a mentee moves into a negative/off-path pipeline
// stage (#810) — required so the drop-off analytics has something to
// aggregate. Reused as-is by the candidate-detail stage select and both board
// pages (drag-and-drop and the per-card CardStageSelect).
export function DropoffReasonDialog({ open, stageLabel, loading = false, onConfirm, onCancel }: DropoffReasonDialogProps) {
  const t = useT();
  const d = t.dropoff;
  const [reasonCode, setReasonCode] = useState('');
  const [reasonNote, setReasonNote] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setReasonCode('');
    setReasonNote('');
    cancelRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const noteRequired = reasonCode === 'OTHER';
  const canConfirm = !!reasonCode && (!noteRequired || reasonNote.trim().length > 0);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dropoff-reason-title"
        data-testid="dropoff-reason-dialog"
        className="w-full max-w-sm rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="dropoff-reason-title" className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">
          {d.dialogTitle.replace('{stage}', stageLabel)}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{d.dialogHint}</p>

        <div className="space-y-3">
          <Select
            label={d.reasonLabel}
            required
            data-testid="dropoff-reason-select"
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            placeholder={d.reasonPlaceholder}
            options={DROPOFF_REASON_CODES.map((code) => ({ value: code, label: d.reasons[code] }))}
          />
          <div>
            <Textarea
              aria-label={d.noteLabel}
              data-testid="dropoff-reason-note"
              placeholder={d.notePlaceholder}
              maxLength={2000}
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
            />
            {noteRequired && <p className="mt-1 text-xs text-gray-500">{d.noteRequiredHint}</p>}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} type="button" variant="secondary" disabled={loading} onClick={onCancel} data-testid="dropoff-reason-cancel">
            {d.cancel}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={loading}
            disabled={loading || !canConfirm}
            onClick={() => onConfirm(reasonCode, reasonNote.trim())}
            data-testid="dropoff-reason-confirm"
          >
            {d.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
