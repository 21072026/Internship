'use client';

import { useEffect, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { useT } from '@/i18n/client';
import {
  SKILL_LIMITS,
  parseSkills,
  skillKey,
  splitSkillInput,
  normalizeSkillName,
  clipSkillLabel,
} from '@/lib/skills';

/**
 * The skills editor every form shares (#2314).
 *
 * WHY IT IS NOT AN <input> ANY MORE
 *   The field it replaces was a single-line text input split on commas. A
 *   browser drops the line breaks out of a multi-line paste, so the CV list a
 *   mentee pasted arrived space-joined — one 300-character "skill" that nothing
 *   could split afterwards, on the server or in a migration. The clipboard is
 *   the only place that text still has its separators, so this component reads
 *   the paste from `onPaste` and splits it there, before the DOM can flatten it.
 *
 * Everything else follows from that: a committed skill is a chip (so "did it
 * take my list?" is answered by looking), the counter and the warnings are
 * visible while typing, and the cap is enforced here with the same numbers
 * `@/lib/skills` gives the routes — a limit only one side holds is not a limit.
 *
 * AUTOCOMPLETE (#1818)
 *   While typing, the field asks `suggestUrl` (default `/api/skills/suggest`)
 *   for the org's canonical skills and offers them as a listbox — an ARIA 1.2
 *   combobox: arrows move, Enter picks, Escape closes. Picking one commits its
 *   canonical LABEL, so what a mentee picks is the same string, and resolves to
 *   the same `Skill` row, as what a mentor was tagged with. A term nobody
 *   curated can still be typed and committed with Enter: the server keeps it in
 *   the free-text list and parks it in the curation queue instead of dropping
 *   it. `suggestUrl={null}` turns suggestions off.
 */
export function SkillsField({
  value,
  onChange,
  label,
  hint,
  error,
  placeholder,
  disabled,
  testId = 'skills-field',
  max = SKILL_LIMITS.maxSkills,
  maxLength = SKILL_LIMITS.maxSkillLength,
  suggestUrl = '/api/skills/suggest',
}: {
  value: string[];
  onChange: (skills: string[]) => void;
  label?: string;
  hint?: string;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
  /** Skills allowed in the list. Requisitions raise it (@/lib/skills). */
  max?: number;
  /** Characters allowed in one skill. Raised alongside `max`. */
  maxLength?: number;
  /** Autocomplete endpoint (gets `q`); `null` turns suggestions off. */
  suggestUrl?: string | null;
}) {
  const t = useT();
  const copy = t.skillsInput;
  const [draft, setDraft] = useState('');
  /** The transient line under the field: what the last commit did, or refused. */
  const [notice, setNotice] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const atLimit = value.length >= max;

  const [options, setOptions] = useState<{ id: string; label: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listboxId = `${testId}-listbox`;

  // Ask for suggestions while typing: debounced, and a newer keystroke aborts
  // the older request so a slow answer can never overwrite a fresh one.
  useEffect(() => {
    const q = draft.trim();
    if (!suggestUrl || disabled || atLimit || q.length === 0) {
      setOptions([]);
      setActive(-1);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const sep = suggestUrl.includes('?') ? '&' : '?';
        const res = await fetch(`${suggestUrl}${sep}q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (!res.ok) return;
        const body = (await res.json()) as { suggestions?: { id: string; label: string }[] };
        const taken = new Set(value.map(skillKey));
        const next = (body.suggestions ?? []).filter((o) => !taken.has(skillKey(o.label)));
        setOptions(next);
        setActive(-1);
        setOpen(next.length > 0);
      } catch {
        /* aborted or offline: typing still works without suggestions */
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft, suggestUrl, disabled, atLimit, value]);

  const closeList = () => {
    setOpen(false);
    setActive(-1);
  };

  /**
   * Add candidates (already split) to the list, and say what happened. One
   * function for typing, pasting and blurring so the three cannot drift.
   */
  const commit = (raw: string): boolean => {
    const candidates = splitSkillInput(raw);
    if (candidates.length === 0) return true;

    const kept: string[] = [];
    const seen = new Set(value.map(skillKey));
    let duplicates = 0;
    let tooLong: string | null = null;
    let overflow = 0;

    for (const candidate of candidates) {
      if (candidate.length > maxLength) {
        tooLong ??= candidate;
        continue;
      }
      const key = skillKey(candidate);
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      if (value.length + kept.length >= max) {
        overflow++;
        continue;
      }
      seen.add(key);
      kept.push(candidate);
    }

    if (kept.length > 0) onChange([...value, ...kept]);

    // Report the refusals first — they are the half the user has to act on.
    if (tooLong) {
      setNotice({
        tone: 'warn',
        text: copy.tooLong
          .replace('{max}', String(maxLength))
          .replace('{sample}', clipSkillLabel(tooLong)),
      });
      // The rejected text stays in the box so it can be edited, not retyped.
      return false;
    }
    if (overflow > 0) {
      setNotice({ tone: 'warn', text: copy.tooMany.replace('{max}', String(max)) });
      return false;
    }
    if (kept.length > 1) {
      setNotice({ tone: 'info', text: copy.splitInto.replace('{count}', String(kept.length)) });
    } else if (duplicates > 0) {
      setNotice({ tone: 'warn', text: copy.duplicate.replace('{count}', String(duplicates)) });
    } else {
      setNotice(null);
    }
    return true;
  };

  const commitDraft = () => {
    closeList();
    if (!draft.trim()) {
      setDraft('');
      return;
    }
    if (commit(draft)) setDraft('');
  };

  const pick = (label: string) => {
    closeList();
    if (commit(label)) setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const listOpen = open && options.length > 0;
    if (listOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const last = options.length - 1;
      setActive((i) => (event.key === 'ArrowDown' ? (i >= last ? 0 : i + 1) : i <= 0 ? last : i - 1));
      return;
    }
    if (!listOpen && event.key === 'ArrowDown' && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive(0);
      return;
    }
    if (event.key === 'Escape' && listOpen) {
      event.preventDefault();
      closeList();
      return;
    }
    if (event.key === 'Enter' && listOpen && active >= 0 && active < options.length) {
      event.preventDefault();
      pick(options[active].label);
      return;
    }
    if (event.key === 'Enter' || event.key === ',' || event.key === ';' || event.key === 'Tab') {
      // Tab only commits when there is something to commit, so the key still
      // moves focus on an empty field.
      if (event.key === 'Tab' && !draft.trim()) return;
      event.preventDefault();
      commitDraft();
      return;
    }
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
      setNotice(null);
    }
  };

  /**
   * The whole reason this component exists: read the clipboard text, not the
   * input value, so a multi-line list is still multi-line when it is split.
   */
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!text) return;
    // Concatenated, not space-joined: someone who typed "Rea" and pasted
    // "ct, Node" means React.
    const merged = draft ? draft + text : text;
    // A paste with no separator at all is left in the box to be edited by hand
    // (and, if it is over-long, refused with the reason) rather than silently
    // dropped — the same call handles both.
    event.preventDefault();
    if (commit(merged)) setDraft('');
    else setDraft(normalizeSkillName(merged));
  };

  const parsed = parseSkills(value, { maxSkills: max, maxSkillLength: maxLength });
  const counterTone =
    value.length >= max
      ? 'text-red-600 dark:text-red-400'
      : value.length >= Math.min(SKILL_LIMITS.warnSkills, max)
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-gray-500 dark:text-gray-400';

  return (
    <div className="w-full" data-testid={testId}>
      {label && (
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <label htmlFor={`${testId}-input`} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            {label}
          </label>
          <span data-testid={`${testId}-counter`} className={`text-xs tabular-nums ${counterTone}`}>
            {copy.count.replace('{count}', String(value.length)).replace('{max}', String(max))}
          </span>
        </div>
      )}

      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5" data-testid={`${testId}-chips`}>
          {value.map((skill) => (
            <span
              key={skill}
              data-testid={`${testId}-chip`}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/40 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300"
            >
              <span className="truncate">{skill}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onChange(value.filter((s) => s !== skill));
                  setNotice(null);
                }}
                aria-label={`${copy.remove}: ${skill}`}
                className="text-blue-400 hover:text-blue-700 dark:hover:text-blue-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        id={`${testId}-input`}
        data-testid={`${testId}-input`}
        type="text"
        value={draft}
        disabled={disabled}
        // One over-long skill cannot be typed in either; the counter and the
        // notice explain the refusal, this just stops it growing further.
        maxLength={maxLength * 2}
        placeholder={atLimit ? copy.full : placeholder}
        aria-label={label}
        aria-describedby={`${testId}-help`}
        role={suggestUrl ? 'combobox' : undefined}
        aria-autocomplete={suggestUrl ? 'list' : undefined}
        aria-expanded={suggestUrl ? open && options.length > 0 : undefined}
        // Only while the listbox exists: an IDREF to a missing element is an axe violation.
        aria-controls={suggestUrl && open && options.length > 0 ? listboxId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listboxId}-${active}` : undefined}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={commitDraft}
        className={`block min-h-11 w-full rounded-lg border px-3.5 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 transition-colors duration-150 focus:outline-none focus:ring-2 ${
          error
            ? 'border-red-300 bg-red-50 focus:border-red-400 focus:ring-red-200'
            : 'border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 focus:border-blue-400 focus:ring-blue-100'
        }`}
      />

      {suggestUrl && open && options.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={copy.suggestions}
          data-testid={listboxId}
          className="relative z-20 mt-1 max-h-60 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-1 shadow-lg"
        >
          {options.map((option, i) => (
            <li
              key={option.id}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={i === active}
              data-testid={`${testId}-option`}
              // mousedown, not click: a click would blur the input first, and the
              // blur commits the half-typed draft instead of the option.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(option.label);
              }}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-3.5 py-2 text-sm ${
                i === active
                  ? 'bg-blue-100 text-blue-900 dark:bg-blue-900/60 dark:text-blue-100'
                  : 'text-gray-800 dark:text-gray-200'
              }`}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}

      <div id={`${testId}-help`} aria-live="polite">
        {error ? (
          <p className="mt-1.5 text-xs text-red-600">{error}</p>
        ) : notice ? (
          <p
            data-testid={`${testId}-notice`}
            className={`mt-1.5 text-xs ${notice.tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-600 dark:text-gray-400'}`}
          >
            {notice.text}
          </p>
        ) : (
          <p className="mt-1.5 text-xs text-gray-500">{hint ?? copy.hint}</p>
        )}
        {/* A list loaded from an older row can already break the rules; say so
            rather than letting the save fail with a 400 nobody expected. */}
        {parsed.issues.some((issue) => issue.code === 'too_long') && (
          <p data-testid={`${testId}-legacy-warning`} className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {copy.existingTooLong.replace('{max}', String(maxLength))}
          </p>
        )}
      </div>
    </div>
  );
}
