'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { useT } from '@/i18n/client';

// Contextual help (#2067): a small "?" button that opens one short, localised
// explanation right next to it. Works on its own — no tour, no server state.
// The text is `guidance.help.<helpKey>`; a key with no text renders nothing,
// so a typo cannot ship an empty bubble. Escape or a click elsewhere closes
// it and focus returns to the button.

export function HelpTip({ helpKey, className = '' }: { helpKey: string; className?: string }) {
  const t = useT();
  const text = (t.guidance.help as Record<string, string>)[helpKey];
  const [open, setOpen] = useState(false);
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  if (!text) return null;
  return (
    <span ref={boxRef} className={`relative inline-flex align-middle ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={t.guidance.helpLabel}
        onClick={() => setOpen((o) => !o)}
        data-testid={`helptip-${helpKey}`}
        className="rounded-full p-0.5 text-gray-400 hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:text-gray-500 dark:hover:text-blue-400"
      >
        <HelpCircle className="h-4 w-4" aria-hidden="true" />
      </button>
      <span
        id={id}
        role="note"
        hidden={!open}
        data-testid={`helptip-${helpKey}-text`}
        className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white p-3 text-left text-sm font-normal text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
      >
        {text}
      </span>
    </span>
  );
}
