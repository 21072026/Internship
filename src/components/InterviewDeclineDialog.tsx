'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { useT } from '@/i18n/client';
import { INTERVIEW_DECLINE_REASON_CODES } from '@/lib/interviewDeclineReasons';

interface InterviewDeclineDialogProps {
  open: boolean;
  loading?: boolean;
  onConfirm: (reasonCode: string, note: string) => void;
  onCancel: () => void;
}

export function InterviewDeclineDialog({ open, loading = false, onConfirm, onCancel }: InterviewDeclineDialogProps) {
  const t = useT();
  const text = t.interviewRequests;
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const dialogRef = useModalFocus<HTMLDivElement>(open, onCancel);

  useEffect(() => {
    if (!open) return;
    setReasonCode('');
    setNote('');
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="interview-decline-title"
        data-testid="interview-decline-dialog"
        tabIndex={-1}
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="interview-decline-title" className="mb-1 text-base font-semibold text-gray-900 dark:text-gray-100">
          {text.declineDialogTitle}
        </h2>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{text.declineDialogHint}</p>
        <div className="space-y-3">
          <Select
            label={text.declineReasonLabel}
            required
            data-testid="interview-decline-reason"
            value={reasonCode}
            onChange={(event) => setReasonCode(event.target.value)}
            placeholder={text.declineReasonPlaceholder}
            options={INTERVIEW_DECLINE_REASON_CODES.map((code) => ({
              value: code,
              label: t.interviewDeclineReasons[code],
            }))}
          />
          <div>
            <label htmlFor="interview-decline-note" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {text.declineNoteLabel}
            </label>
            <Textarea
              id="interview-decline-note"
              data-testid="interview-decline-note"
              placeholder={text.declineNotePlaceholder}
              maxLength={1000}
              showCounter
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={loading} onClick={onCancel} data-testid="interview-decline-cancel">
            {text.declineCancel}
          </Button>
          <Button
            type="button"
            variant="danger"
            loading={loading}
            disabled={loading || !reasonCode}
            onClick={() => onConfirm(reasonCode, note.trim())}
            data-testid="interview-decline-confirm"
          >
            {text.declineConfirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
