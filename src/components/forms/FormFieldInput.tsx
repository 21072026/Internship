'use client';

import { useLocale, useT } from '@/i18n/client';
import { DEFAULT_SCALE, validateResponse, type FormFieldDef, type FormFieldOption, type LocalizedText, type ValidationErrorKey } from '@/lib/forms/schema';

// One admin-defined question as a participant sees it (#1802). The builder's
// live preview and the real forms (#1803: registration, profile) render the
// SAME component and validate with the SAME validateResponse() the API runs,
// so a preview cannot promise a form the participant will not get.

export interface RenderedField extends FormFieldDef {
  labels: LocalizedText;
  helpText?: LocalizedText | null;
}

/** The text in `locale`, falling back to EN, then to whatever was written. */
export function localized(text: LocalizedText | null | undefined, locale: string): string {
  if (!text) return '';
  const t = text as Record<string, string | undefined>;
  return (t[locale] || t.en || t.tr || t.de || '').trim();
}

export function fieldError(field: RenderedField, value: unknown): ValidationErrorKey | null {
  return validateResponse(field, value);
}

export function FormFieldInput({
  field,
  value,
  onChange,
  showError = false,
  locale: localeOverride,
  testIdPrefix = 'form-field',
}: {
  field: RenderedField;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Show the validation message (after a submit attempt, or always in the preview). */
  showError?: boolean;
  /** The builder previews the locale being edited, not the admin's own. */
  locale?: string;
  testIdPrefix?: string;
}) {
  const t = useT();
  const r = t.surveyRespond;
  const own = useLocale();
  const locale = localeOverride ?? own;
  const id = `${testIdPrefix}-${field.key}`;
  const label = localized(field.labels, locale) || field.key;
  const help = localized(field.helpText, locale);
  const options: { value: string; label: string }[] = (field.options ?? []).map((o: FormFieldOption) => ({ value: o.value, label: localized(o.labels, locale) || o.value }));
  const error = showError ? fieldError(field, value) : null;
  const input = 'rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';
  const pill = (active: boolean) =>
    `min-w-9 h-9 px-2 rounded-lg border text-sm font-medium ${active ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:border-gray-600'}`;

  let control: React.ReactNode;
  switch (field.type) {
    case 'SELECT':
      control = (
        <select id={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)} className={`${input} w-full`} data-testid={id}>
          <option value="">{r.selectPlaceholder}</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'MULTI_SELECT': {
      const current = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <div className="space-y-1" data-testid={id}>
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              <input type="checkbox" checked={current.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...current, o.value] : current.filter((v) => v !== o.value))} />
              {o.label}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'BOOLEAN':
      control = (
        <div className="flex gap-2" role="radiogroup" aria-labelledby={`${id}-label`} data-testid={id}>
          <button type="button" role="radio" aria-checked={value === true} onClick={() => onChange(true)} className={pill(value === true)}>{r.yes}</button>
          <button type="button" role="radio" aria-checked={value === false} onClick={() => onChange(false)} className={pill(value === false)}>{r.no}</button>
        </div>
      );
      break;
    case 'SCALE': {
      const scale = field.scale ?? DEFAULT_SCALE;
      control = (
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-labelledby={`${id}-label`} data-testid={id}>
          {Array.from({ length: scale.max - scale.min + 1 }, (_, i) => scale.min + i).map((n) => (
            <button key={n} type="button" role="radio" aria-checked={value === n} onClick={() => onChange(n)} className={pill(value === n)}>{n}</button>
          ))}
        </div>
      );
      break;
    }
    case 'NUMBER':
      control = <input id={id} type="number" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} className={`${input} w-40`} data-testid={id} />;
      break;
    case 'DATE':
      control = <input id={id} type="date" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)} className={input} data-testid={id} />;
      break;
    case 'LONG_TEXT':
      control = <textarea id={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} rows={4} maxLength={5000} className={`${input} block w-full`} data-testid={id} />;
      break;
    default:
      control = <input id={id} type="text" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} maxLength={500} className={`${input} block w-full`} data-testid={id} />;
  }

  return (
    <div className="space-y-1">
      <label id={`${id}-label`} htmlFor={id} className="block text-sm font-medium text-gray-800 dark:text-gray-100">
        {label}
        {field.required && <span aria-hidden className="ml-0.5 text-red-600">*</span>}
      </label>
      {help && <p className="text-xs text-gray-500">{help}</p>}
      {control}
      {error && <p role="alert" className="text-xs text-red-600" data-testid={`${id}-error`}>{r.errors[error]}</p>}
    </div>
  );
}
