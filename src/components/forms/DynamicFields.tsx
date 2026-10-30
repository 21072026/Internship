'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { FormFieldInput, fieldError, localized, type RenderedField } from '@/components/forms/FormFieldInput';
import type { FormSurface } from '@/lib/forms/definitionRule';
import type { LocalizedText } from '@/lib/forms/schema';

// The admin-defined questions of one surface, inside a form that already
// exists (#1803). ONE renderer for every surface: the host form owns its own
// fields and its submit button; this adds the published questions for the
// caller's role and saves the caller's own answers through
// PUT /api/forms/responses, which runs the same validateResponse().
//
// When no form is published for the surface the hook stays empty and the
// component renders nothing — the host form is exactly what it was before.

interface ActiveForm {
  id: string;
  key: string;
  title: LocalizedText | null;
  fields: RenderedField[];
}

export interface DynamicFieldsState {
  forms: ActiveForm[];
  answers: Record<string, Record<string, unknown>>;
  setAnswer: (formKey: string, fieldKey: string, value: unknown) => void;
  showErrors: boolean;
  /** Client-side check with the shared validator; reveals the messages. */
  validate: () => boolean;
  /** Save every form's answers; null on success, else the API's code. */
  save: () => Promise<string | null>;
}

export function useDynamicFields(surface: FormSurface): DynamicFieldsState {
  const [forms, setForms] = useState<ActiveForm[]>([]);
  const [answers, setAnswers] = useState<Record<string, Record<string, unknown>>>({});
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch(`/api/forms/active?surface=${surface}`).then((r) => (r.ok ? r.json() : { forms: [] })),
      fetch(`/api/forms/responses?surface=${surface}`).then((r) => (r.ok ? r.json() : { answers: {} })),
    ])
      .then(([a, b]) => {
        if (!live) return;
        setForms(Array.isArray(a.forms) ? a.forms : []);
        setAnswers(b.answers && typeof b.answers === 'object' ? b.answers : {});
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [surface]);

  const setAnswer = useCallback((formKey: string, fieldKey: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [formKey]: { ...prev[formKey], [fieldKey]: value } }));
  }, []);

  const validate = useCallback(() => {
    setShowErrors(true);
    return forms.every((f) => f.fields.every((field) => !fieldError(field, answers[f.key]?.[field.key])));
  }, [forms, answers]);

  const save = useCallback(async () => {
    for (const form of forms) {
      // Every asked field is sent, a cleared one as null — so clearing an
      // optional answer removes it rather than leaving the old one standing.
      const body = Object.fromEntries(form.fields.map((f) => [f.key, answers[form.key]?.[f.key] ?? null]));
      const res = await fetch('/api/forms/responses', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definitionId: form.id, answers: body }),
      });
      if (!res.ok) return ((await res.json().catch(() => ({}))) as { code?: string }).code ?? 'error';
    }
    return null;
  }, [forms, answers]);

  return { forms, answers, setAnswer, showErrors, validate, save };
}

export function DynamicFields({ state, testIdPrefix = 'custom-field' }: { state: DynamicFieldsState; testIdPrefix?: string }) {
  const t = useT();
  const locale = useLocale();
  if (state.forms.length === 0) return null;
  return (
    <div className="space-y-6" data-testid="dynamic-fields">
      {state.forms.map((form) => (
        <fieldset key={form.id} className="space-y-4 border-t border-gray-200 pt-4 dark:border-gray-700">
          <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100">{localized(form.title, locale) || t.dynamicFields.heading}</legend>
          {form.fields.map((field) => (
            <FormFieldInput
              key={field.key}
              field={field}
              value={state.answers[form.key]?.[field.key]}
              onChange={(v) => state.setAnswer(form.key, field.key, v)}
              showError={state.showErrors}
              testIdPrefix={testIdPrefix}
            />
          ))}
        </fieldset>
      ))}
    </div>
  );
}
