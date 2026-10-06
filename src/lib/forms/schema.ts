// The shared field-type union and answer validator (#1800's shape, created by
// #1879 because the survey engine needs it first). CLIENT-SAFE: no Prisma, no
// `node:` import — the builder preview, the rendered form and the API handler
// all call the same validateResponse(), so a value the browser accepts is a
// value the server accepts. Do not write a second validator next to this one.

import { z } from 'zod';

export const FORM_FIELD_TYPES = ['TEXT', 'LONG_TEXT', 'SELECT', 'MULTI_SELECT', 'NUMBER', 'BOOLEAN', 'DATE', 'SCALE'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export function isFormFieldType(value: unknown): value is FormFieldType {
  return typeof value === 'string' && (FORM_FIELD_TYPES as readonly string[]).includes(value);
}

export interface LocalizedText {
  en?: string;
  tr?: string;
  de?: string;
}

export interface FormFieldOption {
  value: string;
  labels: LocalizedText;
}

export interface FormFieldDef {
  key: string;
  type: FormFieldType;
  required?: boolean;
  /** For SELECT / MULTI_SELECT. */
  options?: FormFieldOption[] | null;
  /** For SCALE; defaults to 1..5. */
  scale?: { min: number; max: number } | null;
}

/** A localisable error key — the screen translates it, the API returns it. */
export type ValidationErrorKey = 'required' | 'invalid_type' | 'too_long' | 'not_an_option' | 'out_of_range' | 'invalid_date';

export const TEXT_MAX = 500;
export const LONG_TEXT_MAX = 5000;
export const DEFAULT_SCALE = { min: 1, max: 5 } as const;

const isEmpty = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

/** The zod schema for one field's (non-empty) value. */
export function fieldSchema(field: FormFieldDef): z.ZodType<unknown> {
  const options = new Set((field.options ?? []).map((o) => o.value));
  const scale = field.scale ?? DEFAULT_SCALE;
  switch (field.type) {
    case 'TEXT':
      return z.string({ invalid_type_error: 'invalid_type' }).max(TEXT_MAX, 'too_long');
    case 'LONG_TEXT':
      return z.string({ invalid_type_error: 'invalid_type' }).max(LONG_TEXT_MAX, 'too_long');
    case 'SELECT':
      return z.string({ invalid_type_error: 'invalid_type' }).refine((v) => options.has(v), 'not_an_option');
    case 'MULTI_SELECT':
      return z
        .array(z.string({ invalid_type_error: 'invalid_type' }), { invalid_type_error: 'invalid_type' })
        .refine((vs) => vs.every((v) => options.has(v)) && new Set(vs).size === vs.length, 'not_an_option');
    case 'NUMBER':
      return z.number({ invalid_type_error: 'invalid_type' }).finite('invalid_type');
    case 'BOOLEAN':
      return z.boolean({ invalid_type_error: 'invalid_type' });
    case 'DATE':
      return z
        .string({ invalid_type_error: 'invalid_type' })
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date')
        .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'invalid_date');
    case 'SCALE':
      return z
        .number({ invalid_type_error: 'invalid_type' })
        .int('invalid_type')
        .min(scale.min, 'out_of_range')
        .max(scale.max, 'out_of_range');
  }
}

/** null when the value is acceptable; otherwise the first error key. */
export function validateResponse(field: FormFieldDef, value: unknown): ValidationErrorKey | null {
  if (isEmpty(value)) return field.required ? 'required' : null;
  const result = fieldSchema(field).safeParse(value);
  if (result.success) return null;
  return (result.error.issues[0]?.message as ValidationErrorKey) ?? 'invalid_type';
}

/**
 * Can this field feed the matching engine? Only bounded answers can be scored
 * fairly and explained; an unbounded string never can, and matching is an
 * input to an automated decision about a person.
 */
export function canBeMatchable(field: Pick<FormFieldDef, 'type'>): boolean {
  return field.type === 'SELECT' || field.type === 'MULTI_SELECT' || field.type === 'BOOLEAN' || field.type === 'SCALE' || field.type === 'NUMBER';
}
