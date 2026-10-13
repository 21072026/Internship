'use client';

import { useState } from 'react';
import { Languages, Check, Sparkles } from 'lucide-react';
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
        // The body was read once above — a second res.json() would throw and hide the code.
        setError(body.code === 'feature_locked' ? t.organizations.featureLocked : body.code === 'disabled' ? m.aiOff : m.unavailable);
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

/**
 * "Draft from a brief" (#2055, part 2): a short brief in, a draft in all three
 * languages out — offered only while every language is still empty, so it can
 * never replace anything a person wrote. Every drafted locale is marked
 * machine-written until reviewed; nothing is saved or sent from here.
 */
export function DraftFromBrief({
  value,
  purpose,
  onDrafted,
  testId,
}: {
  value: LocaleMap;
  purpose: TranslationPurpose;
  onDrafted: (next: LocaleMap, machine: Locale[]) => void;
  testId: string;
}) {
  const t = useT();
  const a = t.authoringAssist;
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (emptyLocales(value).length !== 3) return null;

  const draft = async () => {
    if (brief.trim().length < 3) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/ai/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose, brief: brief.trim() }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The body was read once above — a second res.json() would throw and hide the code.
        setError(body.code === 'feature_locked' ? t.organizations.featureLocked : body.code === 'disabled' ? a.aiOff : a.unavailable);
        return;
      }
      // Through mergeMachine like a translation: empty locales only, all marked.
      const merged = mergeMachine(value, body.draft ?? {}, []);
      onDrafted(merged.map, merged.machineTranslated);
      setBrief('');
    } catch {
      setError(a.unavailable);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder={a.briefPlaceholder}
        maxLength={2000}
        className="w-56 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
        data-testid={`${testId}-brief`}
        aria-label={a.briefPlaceholder}
      />
      <button
        type="button"
        onClick={() => void draft()}
        disabled={busy || brief.trim().length < 3}
        className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-800 dark:text-indigo-300"
        data-testid={testId}
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden /> {busy ? a.drafting : a.draft}
      </button>
      {error && <span role="alert" className="text-xs text-red-600" data-testid={`${testId}-error`}>{error}</span>}
    </span>
  );
}
