'use client';

import { useState } from 'react';
import { Languages, Check } from 'lucide-react';
import { useLocale, useT } from '@/i18n/client';
import { emptyLocales, mergeMachine, pickSource, type LocaleMap, type TranslationPurpose } from '@/lib/machineTranslation';
import type { Locale } from '@/i18n/config';

// "Fill the empty languages" for a tenant-authored multilingual field (#2055).
// Sends only the source text and the EMPTY locales; folds the reply in with
// mergeMachine, which never overwrites a filled locale. The result is a draft
// in the editor — nothing is saved until the admin saves the form.

export function TranslationFillButton({
  value,
  machine,
  purpose,
  onFilled,
  testId,
}: {
  value: LocaleMap;
  machine: Locale[];
  purpose: TranslationPurpose;
  onFilled: (next: LocaleMap, machine: Locale[]) => void;
  testId: string;
}) {
  const t = useT();
  const m = t.machineTranslation;
  const uiLocale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const source = pickSource(value, uiLocale);
  const empty = emptyLocales(value);
  const disabled = busy || !source || empty.length === 0;

  const fill = async () => {
    if (!source || empty.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/ai/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose, from: source.locale, text: source.text, to: empty }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(m.unavailable);
        return;
      }
      const merged = mergeMachine(value, body.translations ?? {}, machine);
      onFilled(merged.map, merged.machineTranslated);
    } catch {
      setError(m.unavailable);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void fill()}
        disabled={disabled}
        title={!source ? m.noSource : empty.length === 0 ? m.nothingToFill : undefined}
        className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-900/30"
        data-testid={testId}
      >
        <Languages className={`h-3.5 w-3.5 ${busy ? 'animate-pulse' : ''}`} aria-hidden />
        {busy ? m.filling : m.fill}
      </button>
      {error && <span role="alert" className="text-xs text-red-600" data-testid={`${testId}-error`}>{error}</span>}
    </span>
  );
}

/** "Machine-translated — review", under a locale a machine filled, until the admin edits or confirms it. */
export function MachineTranslatedChip({ onConfirm, testId, label }: { onConfirm: () => void; testId: string; label?: string }) {
  const m = useT().machineTranslation;
  return (
    <span className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800" data-testid={testId}>
      {label ? `${label} · ` : ''}{m.chip}
      <button type="button" onClick={onConfirm} className="inline-flex items-center gap-0.5 underline" data-testid={`${testId}-confirm`}>
        <Check className="h-3 w-3" aria-hidden /> {m.confirm}
      </button>
    </span>
  );
}
