'use client';

import { useEffect, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { localized, type RenderedField } from '@/components/forms/FormFieldInput';
import type { LocalizedText } from '@/lib/forms/schema';

// A participant's answers to the admin-defined questions (#1803), read-only,
// on the admin detail views. Renders nothing when the org asks this person
// nothing. Values are shown in the reader's language: an option is its label,
// never its stored value.

interface AnsweredForm {
  id: string;
  key: string;
  title: LocalizedText | null;
  fields: RenderedField[];
  answers: Record<string, unknown>;
}

export function FormAnswersPanel({ userId }: { userId: string }) {
  const t = useT();
  const locale = useLocale();
  const [forms, setForms] = useState<AnsweredForm[]>([]);

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/users/${encodeURIComponent(userId)}/form-answers`)
      .then((r) => (r.ok ? r.json() : { forms: [] }))
      .then((d) => live && setForms(Array.isArray(d.forms) ? d.forms : []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId]);

  if (forms.length === 0) return null;

  const show = (field: RenderedField, value: unknown): string => {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return '—';
    const option = (v: unknown) => localized(field.options?.find((o) => o.value === v)?.labels, locale) || String(v);
    if (Array.isArray(value)) return value.map(option).join(', ');
    if (field.type === 'SELECT') return option(value);
    if (typeof value === 'boolean') return value ? t.surveyRespond.yes : t.surveyRespond.no;
    return String(value);
  };

  return (
    <Card className="mb-6" data-testid="form-answers-panel">
      <CardHeader>
        <CardTitle>{t.dynamicFields.heading}</CardTitle>
      </CardHeader>
      <div className="space-y-4">
        {forms.map((form) => (
          <div key={form.id}>
            {form.title && <p className="mb-1 text-sm font-semibold text-gray-800 dark:text-gray-100">{localized(form.title, locale)}</p>}
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              {form.fields.map((field) => (
                <div key={field.key} className="contents">
                  <dt className="text-gray-500 dark:text-gray-400">{localized(field.labels, locale) || field.key}</dt>
                  <dd className="text-gray-900 dark:text-gray-100" data-testid={`form-answer-${field.key}`}>{show(field, form.answers[field.key])}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Card>
  );
}
