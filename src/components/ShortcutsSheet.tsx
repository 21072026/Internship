'use client';

import { Fragment } from 'react';
import { X } from 'lucide-react';
import { useT } from '@/i18n/client';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { SHORTCUTS, resolveChords, type ShortcutId } from '@/lib/shortcuts';

/**
 * The `?` help sheet (#2079). Every row is generated from `src/lib/shortcuts.ts`
 * — there is no hand-written list here, so the sheet cannot advertise a binding
 * that no longer exists.
 *
 * Dark mode comes from globals.css's flat `html.dark .bg-white` / `.bg-gray-50`
 * / `.text-gray-*` overrides, which outrank Tailwind's `dark:` variants — see
 * the note in CommandPalette.
 */
export function ShortcutsSheet({
  open,
  isMac,
  onClose,
}: {
  open: boolean;
  isMac: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useModalFocus<HTMLDivElement>(open, onClose);

  if (!open) return null;

  const entries = t.shortcuts.entries as Record<ShortcutId, string>;

  return (
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-sheet-title"
        data-testid="shortcuts-sheet"
        tabIndex={-1}
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="shortcuts-sheet-title" className="text-base font-semibold text-gray-900">
              {t.shortcuts.title}
            </h2>
            <p className="text-sm text-gray-500">{t.shortcuts.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.shortcuts.close}
            data-testid="shortcuts-sheet-close"
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <dl className="mt-4 divide-y divide-gray-100">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.id} data-testid={`shortcut-${shortcut.id}`} className="flex items-center justify-between gap-4 py-2.5">
              <dt className="text-sm text-gray-700">{entries[shortcut.id]}</dt>
              <dd className="flex items-center gap-1.5">
                {resolveChords(shortcut.chords, isMac).map((chord, chordIndex) => (
                  <Fragment key={chord.join('+')}>
                    {chordIndex > 0 && <span className="text-xs text-gray-400" aria-hidden="true">/</span>}
                    <span className="flex items-center gap-1">
                      {chord.map((key) => (
                        <kbd
                          key={key}
                          className="min-w-[1.75rem] rounded border border-gray-300 bg-gray-50 px-1.5 py-0.5 text-center text-xs font-medium text-gray-700"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </Fragment>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
