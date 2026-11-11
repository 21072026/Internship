'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { useT } from '@/i18n/client';
import { fillTemplate } from '@/components/ui/fillTemplate';
import type { PickerRole } from '@/lib/userPickerQuery';

export interface PickedPerson {
  id: string;
  fullName: string;
  role: string;
}

/** One page of a searchable picker: never more than this many rows on the wire. */
export const PERSON_PAGE = 20;

/**
 * One bounded, server-side search over the people a mentorship picker may
 * offer (#1437). `enabled: false` sends nothing — a closed dropdown has no
 * reason to download anyone. Every response is checked against the term it was
 * asked for, so a slow answer to an old keystroke never overwrites a newer one.
 */
export function usePeopleSearch(
  term: string,
  { roles, limit = PERSON_PAGE, enabled = true }: { roles: readonly PickerRole[]; limit?: number; enabled?: boolean },
) {
  const [state, setState] = useState<{ people: PickedPerson[]; total: number; loading: boolean; failed: boolean }>({
    people: [],
    total: 0,
    loading: false,
    failed: false,
  });
  const rolesKey = roles.join(',');

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, failed: false }));
    // Debounced: one request per pause in typing, not one per keystroke.
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ view: 'mentorAvailability', roles: rolesKey, limit: String(limit) });
      if (term.trim()) params.set('search', term.trim());
      fetch(`/api/users?${params}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: { users?: PickedPerson[]; total?: number }) => {
          const people = (d.users ?? []).map((u) => ({ id: u.id, fullName: u.fullName, role: u.role }));
          setState({ people, total: d.total ?? people.length, loading: false, failed: false });
        })
        .catch((e: unknown) => {
          if ((e as { name?: string })?.name === 'AbortError') return;
          setState({ people: [], total: 0, loading: false, failed: true });
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, rolesKey, limit, enabled]);

  return state;
}

/**
 * The searchable people picker (#1437) — an ARIA 1.2 combobox over
 * `usePeopleSearch`. It replaced a native `<select>` that needed the tenant's
 * whole user list to open: a thousand options, no search, unusable by keyboard
 * or on a phone. Typing asks the server for one page that matches; arrows move,
 * Enter picks, Escape closes, and the line under the list says when there are
 * more people than shown, so a truncated page never reads as "that is everyone".
 *
 * Controlled by id: `value` is the picked id ('' for none), `selectedName` its
 * label. Typing over a picked person clears the pick (`onChange(null)`), so the
 * field never shows one name while holding another person's id.
 */
export function PersonPicker({
  label,
  value,
  selectedName,
  onChange,
  roles,
  preferRole,
  excludeIds = [],
  placeholder,
  required,
  disabled,
  describe,
  testId,
}: {
  label: string;
  value: string;
  selectedName?: string | null;
  onChange: (person: PickedPerson | null) => void;
  roles: readonly PickerRole[];
  /** Rows of this role lead the page (a mentor can be mentored too, #1141 — the usual case reads first). */
  preferRole?: PickerRole;
  excludeIds?: string[];
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** Extra text after the name, e.g. a role suffix. */
  describe?: (person: PickedPerson) => string;
  testId: string;
}) {
  const t = useT();
  const copy = t.personPicker;
  const inputId = useId();
  const listboxId = `${testId}-listbox`;
  const [draft, setDraft] = useState(selectedName ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // The text the admin typed — the selected name is not a search term.
  const term = value && draft === (selectedName ?? '') ? '' : draft;
  const { people, total, loading, failed } = usePeopleSearch(term, { roles, enabled: open && !disabled });
  const excluded = new Set(excludeIds);
  const options = people
    .filter((p) => !excluded.has(p.id))
    .sort((a, b) => (preferRole ? Number(b.role === preferRole) - Number(a.role === preferRole) : 0));

  // The parent reset or replaced the pick (form cleared, a preset applied):
  // show its name. A pick cleared by typing here is not a reset — the draft is
  // what the admin is typing.
  const lastValue = useRef(value);
  useEffect(() => {
    if (lastValue.current === value) return;
    lastValue.current = value;
    if (value) setDraft(selectedName ?? '');
    else if (!open) setDraft('');
  }, [value, selectedName, open]);

  useEffect(() => setActive(-1), [term]);

  function pick(person: PickedPerson) {
    lastValue.current = person.id;
    setDraft(person.fullName);
    setOpen(false);
    onChange(person);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && options[active]) {
        e.preventDefault();
        pick(options[active]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        // Closing the list must not also close the dialog around it.
        e.stopPropagation();
        setOpen(false);
      }
    }
  }

  const showList = open && options.length > 0;
  const more = total > people.length;

  return (
    <div className="w-full" data-testid={testId}>
      <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <div className="relative">
        <input
          id={inputId}
          data-testid={`${testId}-input`}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          // Only while the listbox exists: an IDREF to a missing element is an axe violation.
          aria-controls={showList ? listboxId : undefined}
          aria-activedescendant={showList && active >= 0 ? `${listboxId}-${active}` : undefined}
          aria-describedby={`${testId}-status`}
          aria-required={required || undefined}
          autoComplete="off"
          disabled={disabled}
          value={draft}
          placeholder={placeholder ?? copy.placeholder}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            // Leaving the field with half a name typed: show the pick again, if any.
            if (value) setDraft(selectedName ?? '');
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
            if (value) {
              lastValue.current = '';
              onChange(null);
            }
          }}
          onKeyDown={onKeyDown}
          className="block min-h-11 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3.5 py-2.5 pr-10 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 transition-colors duration-150 focus:outline-none focus:ring-2 focus:border-blue-400 focus:ring-blue-100 disabled:bg-gray-50 disabled:text-gray-500"
        />
        {value && !disabled && (
          <button
            type="button"
            aria-label={copy.clear}
            data-testid={`${testId}-clear`}
            onClick={() => {
              lastValue.current = '';
              setDraft('');
              onChange(null);
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      {showList && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          data-testid={listboxId}
          className="relative z-20 mt-1 max-h-60 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-1 shadow-lg"
        >
          {options.map((person, i) => (
            <li
              key={person.id}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={person.id === value || i === active}
              data-testid={`${testId}-option-${person.id}`}
              // mousedown, not click: a click would blur the input first and close the list.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(person);
              }}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-3.5 py-2 text-sm ${
                i === active
                  ? 'bg-blue-100 text-blue-900 dark:bg-blue-900/60 dark:text-blue-100'
                  : 'text-gray-800 dark:text-gray-200'
              }`}
            >
              {person.fullName}
              {describe?.(person)}
            </li>
          ))}
        </ul>
      )}
      <p id={`${testId}-status`} data-testid={`${testId}-status`} aria-live="polite" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {open && !loading && failed
          ? copy.failed
          : open && !loading && options.length === 0
            ? copy.noMatches
            : open && more
              ? fillTemplate(copy.more, { shown: String(people.length), total: String(total) })
              : ''}
      </p>
    </div>
  );
}
