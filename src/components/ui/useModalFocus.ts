'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    const style = window.getComputedStyle(element);
    return !element.hidden
      && !element.closest('[aria-hidden="true"], [inert]')
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && element.getClientRects().length > 0;
  });
}

/** Gives a blocking modal initial focus, a focus trap, Escape close, and focus return. */
// Note: This hook assumes only one blocking modal is active at a time.
// If nested/stacked modals are introduced in the future, focus trapping
// and Escape handling should be coordinated to avoid competing listeners.
export function useModalFocus<T extends HTMLElement>(open: boolean, onClose: () => void): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const currentDialog = dialogRef.current;
    if (!currentDialog) return;
    const dialog: HTMLElement = currentDialog;

    const focusable = focusableElements(dialog);
    (focusable[0] ?? dialog).focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const elements = focusableElements(dialog);
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  return dialogRef;
}
