'use client';

import { useCallback, useEffect, useState } from 'react';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { REFERRER_NEW_SOURCE, decodeReferrer } from '@/lib/referrer';

type Person = { id: string; fullName: string };
type SourceRow = { id: string; name: string };

/**
 * The one field that answers "who brought this person in?" (#1296).
 *
 * It replaces two selects that used to sit on two different cards of the
 * candidate screen — "Getiren kişi" (`User.referredById`, a registered person)
 * and "Kaynak" (`User.sourceId`, a `Source` row). They were always the same
 * question, so this renders a single grouped select over both sets, and
 * `onChange` hands the caller *both* columns: the picked one and the other one
 * nulled.
 *
 * Whoever brought a mentee in is very often not in the system (a friend, a
 * teacher, a company contact), so the last option creates a source inline —
 * without leaving the screen for `/admin/sources` and coming back.
 */
export function ReferrerPicker({
  value,
  onChange,
  excludeUserId,
  valueLabel,
  legacyText,
  disabled,
  label,
  hint = true,
  testId = 'referrer-select',
}: {
  /** Encoded referrer — see `encodeReferrer`. */
  value: string;
  /** Called with both columns; persisting them is the caller's job. */
  onChange: (fields: { referredById: string | null; sourceId: string | null }) => void;
  /** The person being edited — nobody refers themselves. */
  excludeUserId?: string;
  /** Label of the current referrer, for the window before the lists load. */
  valueLabel?: string | null;
  /** Legacy free-text `referralSource`, offered as a one-click source. */
  legacyText?: string | null;
  disabled?: boolean;
  label?: string;
  hint?: boolean;
  testId?: string;
}) {
  const t = useT();
  const [people, setPeople] = useState<Person[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/users?view=picker')
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => setPeople(d.users ?? []))
      .catch((e) => console.error('[referrer] people load failed', e));
    fetch('/api/sources')
      .then((r) => (r.ok ? r.json() : { sources: [] }))
      .then((d) => setSources(d.sources ?? []))
      .catch((e) => console.error('[referrer] sources load failed', e));
  }, []);

  // Create a source and select it in one go. Used both by the inline form and by
  // the "save the old free text as a source" shortcut.
  const createSource = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setBusy(true);
      setError('');
      try {
        const res = await fetch('/api/sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!res.ok) throw new Error();
        const { source } = (await res.json()) as { source: SourceRow };
        setSources((prev) => (prev.some((s) => s.id === source.id) ? prev : [...prev, source].sort((a, b) => a.name.localeCompare(b.name))));
        setCreating(false);
        setNewName('');
        onChange({ referredById: null, sourceId: source.id });
      } catch {
        setError(t.referrer.createError);
      } finally {
        setBusy(false);
      }
    },
    [onChange, t]
  );

  const options = [
    { value: '', label: t.referrer.none },
    ...people
      .filter((p) => p.id !== excludeUserId)
      .map((p) => ({ value: `user:${p.id}`, label: p.fullName, group: t.referrer.people })),
    ...sources.map((s) => ({ value: `source:${s.id}`, label: s.name, group: t.referrer.sources })),
    { value: REFERRER_NEW_SOURCE, label: t.referrer.newSource },
  ];

  // A stored pointer whose row isn't in the loaded lists (still loading, or a
  // person this caller's picker doesn't include) would otherwise snap the select
  // to "not recorded" and misreport what is saved. Keep it selected, labelled
  // with what the caller already knows.
  if (value && !options.some((o) => o.value === value)) {
    options.splice(1, 0, { value, label: valueLabel || value });
  }

  return (
    <div className="w-full">
      <Select
        label={label ?? t.referrer.label}
        data-testid={testId}
        disabled={disabled || busy}
        value={value}
        options={options}
        onChange={(e) => {
          const picked = e.target.value;
          if (picked === REFERRER_NEW_SOURCE) {
            setError('');
            setCreating(true);
            return;
          }
          setCreating(false);
          onChange(decodeReferrer(picked));
        }}
      />

      {creating && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            autoFocus
            type="text"
            value={newName}
            disabled={busy}
            placeholder={t.referrer.newSourceName}
            data-testid="referrer-new-source-name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void createSource(newName);
              }
              if (e.key === 'Escape') setCreating(false);
            }}
            className="flex-1 min-w-[10rem] rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
          />
          <Button
            size="sm"
            type="button"
            loading={busy}
            disabled={!newName.trim()}
            data-testid="referrer-new-source-save"
            onClick={() => void createSource(newName)}
          >
            {t.referrer.add}
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => { setCreating(false); setError(''); }}>
            {t.referrer.cancel}
          </Button>
        </div>
      )}

      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}

      {/* Records typed before the merge kept the answer in free text. Show it,
          and make promoting it to a real source a single click. */}
      {!value && legacyText && !creating && (
        <p className="mt-1.5 text-xs text-gray-500 flex flex-wrap items-center gap-2">
          <span>{t.referrer.legacy.replace('{text}', legacyText)}</span>
          <button
            type="button"
            disabled={busy}
            data-testid="referrer-promote-legacy"
            onClick={() => void createSource(legacyText)}
            className="text-blue-600 hover:underline disabled:opacity-50"
          >
            {t.referrer.legacySave}
          </button>
        </p>
      )}

      {/* One explanation at a time: the legacy note already says what the field
          is about, so the generic hint stands down while it shows. */}
      {hint && !creating && !(!value && legacyText) && (
        <p className="mt-1.5 text-xs text-gray-500">{t.referrer.hint}</p>
      )}
    </div>
  );
}
