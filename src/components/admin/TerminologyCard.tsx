'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useLocale, useT } from '@/i18n/client';
import { locales, type Locale } from '@/i18n/config';
import {
  TERM_DEFAULTS,
  TERM_FORMS,
  TERM_PREVIEW_SAMPLE,
  TERM_TOKENS,
  swapTerms,
  type LocaleTerms,
  type TermForm,
  type TermToken,
  type Terminology,
} from '@/lib/terminology';

type Draft = Record<Locale, Record<TermToken, Record<TermForm, string>>>;
type Program = { id: string; name: string };

const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', tr: 'Türkçe', de: 'Deutsch' };

function emptyDraft(): Draft {
  const blank = () => Object.fromEntries(TERM_FORMS.map((f) => [f, ''])) as Record<TermForm, string>;
  return Object.fromEntries(
    locales.map((l) => [l, Object.fromEntries(TERM_TOKENS.map((tok) => [tok, blank()]))]),
  ) as Draft;
}

function draftFrom(terms: Terminology): Draft {
  const d = emptyDraft();
  for (const l of locales) for (const tok of TERM_TOKENS) if (terms[l]?.[tok]) d[l][tok] = { ...terms[l]![tok]! };
  return d;
}

// The complete rows of one locale — what the preview applies and a save sends.
function completeTerms(draft: Draft, l: Locale): LocaleTerms {
  const out: LocaleTerms = {};
  for (const tok of TERM_TOKENS) {
    const forms = draft[l][tok];
    if (TERM_FORMS.every((f) => forms[f].trim() !== '')) out[tok] = forms;
  }
  return out;
}

// The org's own nouns (#1629, #1631, docs/terminology.md): per language, a row
// per catalogued token, four stored forms each, for the whole organization or
// one programme (a programme without its own row shows its org's words and
// says so). A row is all four or nothing; the server prunes anything else
// anyway. Each row is labelled with the DEFAULT word (from the catalogue, not
// the dictionary) so a renamed noun cannot rename its own label, and the
// preview sentence lives in the catalogue for the same reason. Saving
// refreshes the page so the new words take over.
export function TerminologyCard() {
  const t = useT();
  const s = t.settings;
  const router = useRouter();
  const [lang, setLang] = useState<Locale>(useLocale());
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [programId, setProgramId] = useState('');
  const [inherited, setInherited] = useState(false);
  const [planRequired, setPlanRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ReactNode>(null);

  const load = useCallback((pid: string) => {
    fetch(`/api/admin/terminology${pid ? `?programId=${encodeURIComponent(pid)}` : ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setDraft(draftFrom(d.terminology ?? {}));
        setPrograms(d.programs ?? []);
        setInherited(d.inherited === true);
        setPlanRequired(d.plan === 'FREE');
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    load(programId);
  }, [load, programId]);

  const label = (l: Locale, tok: TermToken) => TERM_DEFAULTS[l][tok].oneCap[0];
  const preview = useMemo(() => swapTerms(TERM_PREVIEW_SAMPLE[lang], lang, completeTerms(draft, lang)), [draft, lang]);

  const save = async (next: Draft | null) => {
    setMessage(null);
    const terminology: Terminology = {};
    if (next) {
      for (const l of locales) {
        for (const tok of TERM_TOKENS) {
          const filled = TERM_FORMS.filter((f) => next[l][tok][f].trim() !== '').length;
          if (filled > 0 && filled < TERM_FORMS.length) {
            setLang(l);
            setMessage(fillTemplate(s.terminologyIncomplete, { token: label(l, tok) }));
            return;
          }
        }
        const complete = completeTerms(next, l);
        if (Object.keys(complete).length > 0) terminology[l] = complete;
      }
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/terminology', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminology, ...(programId ? { programId } : {}) }),
      });
      if (res.status === 403 && (await res.clone().json().catch(() => null))?.code === 'plan_required') {
        setPlanRequired(true);
        setMessage(s.terminologyPlanRequired);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const d = await res.json();
      setDraft(draftFrom(d.terminology ?? {}));
      setInherited(d.inherited === true);
      setMessage(s.terminologySaved);
      router.refresh();
    } catch {
      setMessage(s.terminologyFailed);
    } finally {
      setBusy(false);
    }
  };

  // "Reset <language>": the other languages stay as they are.
  const resetLocale = () => {
    const next = { ...draft, [lang]: emptyDraft()[lang] };
    setDraft(next);
    void save(next);
  };

  const formLabels: Record<TermForm, string> = {
    one: s.terminologyFormOne,
    many: s.terminologyFormMany,
    oneCap: s.terminologyFormOneCap,
    manyCap: s.terminologyFormManyCap,
  };

  return (
    <Card data-testid="terminology-card">
      <CardHeader>
        <CardTitle>{s.terminologyTitle}</CardTitle>
      </CardHeader>
      <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">{s.terminologyIntro}</p>
      {planRequired && (
        <p className="mb-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-800" data-testid="terminology-plan-required">
          {s.terminologyPlanRequired}
        </p>
      )}
      {programs.length > 0 && (
        <label className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-500 dark:text-gray-400">{s.terminologyScope}:</span>
          <select
            value={programId}
            onChange={(e) => {
              setMessage(null);
              setProgramId(e.target.value);
            }}
            className="rounded-lg border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
            data-testid="terminology-scope"
          >
            <option value="">{s.terminologyScopeOrg}</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {programId && inherited && (
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400" data-testid="terminology-inherited">
          {s.terminologyInherited}
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm" role="group" aria-label={s.terminologyLanguage}>
        <span className="text-gray-500 dark:text-gray-400">{s.terminologyLanguage}:</span>
        {locales.map((l) => (
          <button
            key={l}
            type="button"
            aria-pressed={lang === l}
            data-testid={`terminology-lang-${l}`}
            onClick={() => setLang(l)}
            className={`rounded-lg border px-3 py-1 ${lang === l ? 'border-blue-600 bg-blue-50 text-blue-700 font-medium' : 'border-gray-300 text-gray-700'}`}
          >
            {LANGUAGE_NAMES[l]}
          </button>
        ))}
      </div>
      <div className="space-y-4">
        {TERM_TOKENS.map((tok) => (
          <fieldset key={tok} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <legend className="px-1 text-sm font-medium">{label(lang, tok)}</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {TERM_FORMS.map((form) => (
                <Input
                  key={form}
                  id={`terminology-${lang}-${tok}-${form}`}
                  label={formLabels[form]}
                  value={draft[lang][tok][form]}
                  placeholder={TERM_DEFAULTS[lang][tok][form][0]}
                  maxLength={40}
                  data-testid={`terminology-${lang}-${tok}-${form}`}
                  onChange={(e) => {
                    const value = e.target.value;
                    setDraft((d) => ({ ...d, [lang]: { ...d[lang], [tok]: { ...d[lang][tok], [form]: value } } }));
                  }}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="mt-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
        <div className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">{s.terminologyPreview}</div>
        <p lang={lang} data-testid="terminology-preview">{preview}</p>
      </div>
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{s.terminologyNote}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" loading={busy} onClick={() => save(draft)} data-testid="terminology-save">
          {s.terminologySave}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={resetLocale} data-testid="terminology-reset-locale">
          {fillTemplate(s.terminologyResetLocale, { language: LANGUAGE_NAMES[lang] })}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => save(null)} data-testid="terminology-reset">
          {s.terminologyReset}
        </Button>
        {message && (
          <span role="status" className="text-sm text-gray-600 dark:text-gray-300" data-testid="terminology-message">
            {message}
          </span>
        )}
      </div>
    </Card>
  );
}
