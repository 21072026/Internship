// What the form builder (#1802) tells an admin before and at publish — PURE and
// client-safe, so the screen and the server say the same thing in the same
// words. The versioning rules themselves are ./definitionRule.ts (#1800).
//
//   · missingLocales — a field that goes live must read in every language the
//     product speaks (EN/TR/DE): label, every option label, and help text when
//     there is any. Publishing is REFUSED otherwise (`missing_locales`), because
//     a participant reading TR would otherwise see an empty question.
//   · proxyWarnings — a field whose key or label looks like a protected
//     characteristic (age, ethnicity, religion, disability, gender, marital
//     status, nationality) gets a WARNING, never a block: such a field can make
//     matching discriminatory and must not be used as a hard rule. The admin
//     decides; the screen makes sure they decided knowingly.
//   · diffFields — what a draft changes against the live version, for the
//     publish confirmation ("already-collected answers are kept").

import { locales } from '@/i18n/config';
import type { LocalizedText } from './schema';

export type BuilderLocale = (typeof locales)[number];

export interface BuilderField {
  key: string;
  type: string;
  labels: LocalizedText | null | undefined;
  helpText?: LocalizedText | null;
  options?: { value: string; labels: LocalizedText }[] | null;
  required?: boolean;
  matchable?: boolean;
  archived?: boolean;
  archivedAt?: string | Date | null;
}

const filled = (t: LocalizedText | null | undefined, l: BuilderLocale) => !!t && typeof t[l] === 'string' && t[l]!.trim() !== '';
const isArchived = (f: BuilderField) => !!f.archived || !!f.archivedAt;

/** Per live field key, the locales it is missing anywhere (label, options, help text). */
export function missingLocales(fields: readonly BuilderField[]): { key: string; locales: BuilderLocale[] }[] {
  const out: { key: string; locales: BuilderLocale[] }[] = [];
  for (const f of fields) {
    if (isArchived(f)) continue;
    const helpUsed = !!f.helpText && locales.some((l) => filled(f.helpText, l));
    const missing = locales.filter(
      (l) => !filled(f.labels, l) || (helpUsed && !filled(f.helpText, l)) || (f.options ?? []).some((o) => !filled(o.labels, l)),
    );
    if (missing.length > 0) out.push({ key: f.key, locales: missing });
  }
  return out;
}

/**
 * The protected characteristics, and words (EN/TR/DE) that point at them. A
 * term matches a WHOLE word, unless it ends in `*`, which makes it a prefix
 * ("birth*" catches "birthdate", "engel*" catches "engelli") — so "age" never
 * fires on "agenda" and "alter" never on "alternative".
 */
export const PROTECTED_PROXIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  age: ['age', 'birth*', 'born', 'dob', 'yaş', 'yas', 'doğum*', 'dogum*', 'alter', 'geburt*', 'jahrgang'],
  ethnicity: ['ethnic*', 'race', 'racial', 'etnik*', 'ırk', 'irk', 'ethnie', 'herkunft', 'rasse'],
  religion: ['religion*', 'religious', 'faith', 'belief*', 'din', 'dini', 'inanç*', 'inanc*', 'mezhep*', 'glaube*', 'konfession*'],
  disability: ['disab*', 'handicap*', 'impair*', 'engel*', 'behinder*'],
  gender: ['gender', 'sex', 'cinsiyet*', 'geschlecht*'],
  marital: ['marital', 'married', 'spouse', 'medeni', 'evli*', 'familienstand', 'verheiratet'],
  nationality: ['nationality', 'citizen*', 'uyruk*', 'vatandaş*', 'vatandas*', 'staatsangeh*', 'nationalität', 'nationalitat'],
});

// Plain lower-casing, with the dot of a Turkish "İ" dropped: a locale-aware
// 'tr' lower-casing would turn an English "I" into a dotless "ı".
const lower = (s: string) => s.toLowerCase().normalize('NFD').replace(/\u0307/g, '').normalize('NFC');

/** Lower-cased words of a key or label (snake_case and spaces split). */
const words = (s: string) => lower(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const hits = (word: string, term: string) => {
  const t = lower(term);
  return t.endsWith('*') ? word.startsWith(t.slice(0, -1)) : word === t;
};

/** Which protected characteristics this field's key or labels point at. */
export function proxyWarnings(field: Pick<BuilderField, 'key' | 'labels'>): string[] {
  const texts = [field.key, ...Object.values(field.labels ?? {}).filter((v): v is string => typeof v === 'string')];
  const ws = texts.flatMap(words);
  return Object.entries(PROTECTED_PROXIES)
    .filter(([, terms]) => ws.some((w) => terms.some((t) => hits(w, t))))
    .map(([characteristic]) => characteristic);
}

export interface FieldChange {
  key: string;
  change: 'added' | 'removed' | 'changed';
  /** For `changed`: which properties differ. */
  props?: ('labels' | 'helpText' | 'options' | 'required' | 'matchable' | 'order')[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What `draft` changes against `live` (null = nothing published yet: everything is added). */
export function diffFields(live: readonly BuilderField[] | null, draft: readonly BuilderField[]): FieldChange[] {
  const liveActive = (live ?? []).filter((f) => !isArchived(f));
  const draftActive = draft.filter((f) => !isArchived(f));
  const before = new Map(liveActive.map((f, i) => [f.key, { f, i }]));
  const after = new Map(draftActive.map((f, i) => [f.key, { f, i }]));
  const out: FieldChange[] = [];
  for (const [key, { f, i }] of after) {
    const prior = before.get(key);
    if (!prior) {
      out.push({ key, change: 'added' });
      continue;
    }
    const props: NonNullable<FieldChange['props']> = [];
    if (!same(prior.f.labels, f.labels)) props.push('labels');
    if (!same(prior.f.helpText, f.helpText)) props.push('helpText');
    if (!same(prior.f.options, f.options)) props.push('options');
    if (!!prior.f.required !== !!f.required) props.push('required');
    if (!!prior.f.matchable !== !!f.matchable) props.push('matchable');
    if (prior.i !== i) props.push('order');
    if (props.length > 0) out.push({ key, change: 'changed', props });
  }
  for (const key of before.keys()) if (!after.has(key)) out.push({ key, change: 'removed' });
  return out;
}
