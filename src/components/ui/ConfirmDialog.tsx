'use client';

import type { ReactNode } from 'react';
import { Button } from './Button';
import { useModalFocus } from './useModalFocus';

export interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  /**
   * Usually one sentence, and every existing caller passes exactly that.
   * Widened to a node for the company delete (#2441), which has to state two
   * different consequences — what is deleted along with the account and what
   * merely loses its link — as separate lines rather than one run-on sentence.
   * A string stays a valid node, so nothing else changes.
   */
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  variant?: 'danger' | 'default';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'default',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useModalFocus<HTMLDivElement>(open, onCancel);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'confirm-dialog-title' : undefined}
        aria-describedby="confirm-dialog-message"
        data-testid="confirm-dialog"
        tabIndex={-1}
        className="w-full max-w-sm rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <h2
            id="confirm-dialog-title"
            className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2"
          >
            {title}
          </h2>
        )}
        {/* A <div>, not a <p>: `message` may now be several elements (#2441),
            and a <p> may not contain block content — React would hydrate it
            into a different tree than it rendered on the server. */}
        <div id="confirm-dialog-message" className="text-sm text-gray-600 dark:text-gray-300">
          {message}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={loading}
            onClick={onCancel}
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={variant === 'danger' ? 'danger' : 'primary'}
            loading={loading}
            disabled={loading}
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
