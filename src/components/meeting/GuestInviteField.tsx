'use client';

import { useState, type KeyboardEvent } from 'react';
import { X, Mail } from 'lucide-react';
import { useT } from '@/i18n/client';

export interface PendingGuest {
  email: string;
  name?: string | null;
}

// The client-side gate is deliberately loose — the server re-validates with
// zod's email() and is the authority. Its whole job is to catch the obvious
// typo before the address is committed to a chip, not to define what an address
// is (RFC 5322 in a regex is a well-known way to reject real addresses).
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * "Also invite these people, who don't have accounts here" (#1430).
 *
 * A chip list rather than a comma-separated text field: an address becomes a
 * chip the moment it is committed, so the organizer can see — before sending —
 * exactly who is about to be mailed and drop the one they mistyped. A free-text
 * field hides a typo until the invitation has already gone out, which for an
 * outsider is an email to a stranger that cannot be recalled.
 */
export function GuestInviteField({
  guests,
  onChange,
  max,
  disabled,
  testIdPrefix = 'guest',
}: {
  guests: PendingGuest[];
  onChange: (next: PendingGuest[]) => void;
  max: number;
  disabled?: boolean;
  /** Distinguishes the two panels that render this on the same page. */
  testIdPrefix?: string;
}) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    const email = draft.trim().toLowerCase();
    if (!email) return;
    if (!LOOKS_LIKE_EMAIL.test(email)) {
      setError(t.meetings.guests.invalid);
      return;
    }
    if (guests.some((g) => g.email === email)) {
      setError(t.meetings.guests.duplicate);
      return;
    }
    if (guests.length >= max) {
      setError(t.meetings.guests.max.replace('{n}', String(max)));
      return;
    }
    onChange([...guests, { email }]);
    setDraft('');
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter and comma both commit; Enter must not submit an enclosing form and
    // fire the invitation with the draft address still uncommitted.
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
      return;
    }
    // Backspace on an empty box takes back the last chip — the standard
    // behaviour of every chip field, and the fastest way to undo a mistake.
    if (e.key === 'Backspace' && !draft && guests.length > 0) {
      onChange(guests.slice(0, -1));
    }
  };

  return (
    <div className="w-full">
      <label
        htmlFor={`${testIdPrefix}-email-input`}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
      >
        {t.meetings.guests.label}
      </label>

      {guests.length > 0 && (
        <ul className="flex flex-wrap gap-2 mb-2" data-testid={`${testIdPrefix}-chips`}>
          {guests.map((g) => (
            <li
              key={g.email}
              data-testid={`${testIdPrefix}-chip-${g.email}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 pl-2.5 pr-1.5 py-1 text-xs font-medium"
            >
              <Mail className="h-3 w-3" aria-hidden="true" />
              <span className="max-w-[14rem] truncate">{g.email}</span>
              <button
                type="button"
                aria-label={t.meetings.guests.remove.replace('{email}', g.email)}
                onClick={() => onChange(guests.filter((x) => x.email !== g.email))}
                className="rounded-full p-0.5 hover:bg-blue-200 dark:hover:bg-blue-800"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <input
          id={`${testIdPrefix}-email-input`}
          data-testid={`${testIdPrefix}-email-input`}
          type="email"
          inputMode="email"
          autoComplete="off"
          disabled={disabled}
          value={draft}
          placeholder={t.meetings.guests.placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          // Committing on blur too: leaving a typed address in the box and
          // clicking "Send invite" would otherwise silently drop that guest.
          onBlur={commit}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${testIdPrefix}-email-error` : `${testIdPrefix}-email-hint`}
          className="block min-h-11 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3.5 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-blue-400 focus:ring-blue-100"
        />
        <button
          type="button"
          data-testid={`${testIdPrefix}-email-add`}
          onClick={commit}
          disabled={disabled || !draft.trim()}
          className="shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 px-3 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
        >
          {t.meetings.guests.add}
        </button>
      </div>

      {error ? (
        <p id={`${testIdPrefix}-email-error`} data-testid={`${testIdPrefix}-email-error`} className="mt-1 text-xs text-red-500">
          {error}
        </p>
      ) : (
        <p id={`${testIdPrefix}-email-hint`} className="mt-1 text-xs text-gray-500">
          {t.meetings.guests.hint}
        </p>
      )}
    </div>
  );
}
