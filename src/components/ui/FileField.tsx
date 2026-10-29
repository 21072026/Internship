'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';

// A file input in the app's language and theme (#3175). A bare <input type="file">
// draws the browser's own button ("Datei auswählen / Keine ausgewählt"), in the
// browser's language and unstyled in dark mode. Here the real input stays in the
// tab order (visually hidden, never display:none, so it keeps focus, keyboard and
// screen-reader access and `setInputFiles` still reaches it), and its focus ring is
// drawn on the visible button. The chosen file's name — or `noneLabel` — is the
// input's description.

interface FileFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'> {
  id: string;
  /** The button text, e.g. "Choose file". */
  chooseLabel: string;
  /** Shown while nothing is chosen, e.g. "No file chosen". */
  noneLabel: string;
  /** The chosen file's name; the parent owns it, so a refused file can read as none. */
  fileName: string | null;
}

export const FileField = forwardRef<HTMLInputElement, FileFieldProps>(
  ({ id, chooseLabel, noneLabel, fileName, className, ...props }, ref) => (
    <div className={['flex min-w-0 items-center gap-3', className].filter(Boolean).join(' ')}>
      <input ref={ref} id={id} type="file" className="peer sr-only" aria-describedby={`${id}-name`} {...props} />
      <label
        htmlFor={id}
        className="inline-flex max-lg:min-h-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors duration-150 hover:bg-gray-50 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
      >
        {chooseLabel}
      </label>
      <span id={`${id}-name`} className="min-w-0 truncate text-sm text-gray-600 dark:text-gray-400" title={fileName ?? undefined}>
        {fileName ?? noneLabel}
      </span>
    </div>
  ),
);

FileField.displayName = 'FileField';
