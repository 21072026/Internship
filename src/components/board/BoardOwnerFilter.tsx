'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';

// The admin board's "Owner" filter (#3658): narrow the board to the records of
// one or more owners (a mentor, or a sales rep in MARKETING). The list comes
// from the tenant's active MENTORs and ADMINs (an admin in sales mode owns
// records too). The filter is applied on the server (`?owners=` on
// GET /api/mentorship), so column counts and paging agree with what is shown.

export interface OwnerOption {
  id: string;
  fullName: string;
}

export function useOwnerOptions(): OwnerOption[] {
  const [options, setOptions] = useState<OwnerOption[]>([]);
  useEffect(() => {
    let alive = true;
    const load = (role: string) =>
      fetch(`/api/users?view=picker&status=active&role=${role}`)
        .then((r) => (r.ok ? r.json() : { users: [] }))
        .then((d) => (d.users ?? []) as OwnerOption[])
        .catch(() => [] as OwnerOption[]);
    Promise.all([load('MENTOR'), load('ADMIN')]).then(([mentors, admins]) => {
      if (!alive) return;
      const seen = new Set<string>();
      const all = [...mentors, ...admins].filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
      setOptions(all.sort((a, b) => a.fullName.localeCompare(b.fullName)));
    });
    return () => {
      alive = false;
    };
  }, []);
  return options;
}

export function BoardOwnerFilter({
  options,
  selected,
  onChange,
}: {
  options: OwnerOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useT();
  const L = t.adminBoard;
  if (options.length === 0) return null;
  const summary = selected.length === 0 ? L.ownerFilterAll : L.ownerFilterCount.replace('{n}', String(selected.length));
  return (
    <details className="relative" data-testid="board-owner-filter">
      <summary className="cursor-pointer list-none rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200">
        {L.ownerFilter}: <span className="font-medium" data-testid="board-owner-filter-summary">{summary}</span>
      </summary>
      <div className="absolute z-20 mt-1 max-h-72 w-64 overflow-auto rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900">
        <ul className="space-y-1">
          {options.map((o) => {
            const on = selected.includes(o.id);
            return (
              <li key={o.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onChange(on ? selected.filter((id) => id !== o.id) : [...selected, o.id])}
                    data-testid={`board-owner-option-${o.id}`}
                  />
                  <span className="truncate">{o.fullName}</span>
                </label>
              </li>
            );
          })}
        </ul>
        {selected.length > 0 && (
          <button
            type="button"
            className="mt-2 text-xs text-blue-600 hover:underline dark:text-blue-400"
            onClick={() => onChange([])}
            data-testid="board-owner-filter-clear"
          >
            {L.ownerFilterClear}
          </button>
        )}
      </div>
    </details>
  );
}
