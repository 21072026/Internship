import { test, expect } from '@playwright/test';
import { dictionaries } from '../src/i18n/dictionaries';
import { overlayEntries, applyVerticalOverlay } from '../src/i18n/verticalOverlays';

// Validates the vertical terminology overlays (#2354). A Playwright-run unit
// spec (like program-templates.unit) because verticalOverlays imports through
// the `@/` alias, which the plain node runner used by check:i18n cannot resolve.

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, key));
    else out[key] = v;
  }
  return out;
}

test('INTERNSHIP overrides nothing — the no-op guarantee', () => {
  for (const { vertical, overlay } of overlayEntries()) {
    if (vertical === 'INTERNSHIP') {
      expect(Object.keys(overlay).length, 'INTERNSHIP overlay must stay empty').toBe(0);
    }
  }
  // And applying it returns the very same object (referential identity).
  for (const locale of ['en', 'tr', 'de'] as const) {
    const base = dictionaries[locale];
    expect(applyVerticalOverlay(base, locale, 'INTERNSHIP')).toBe(base);
    expect(applyVerticalOverlay(base, locale, null)).toBe(base);
  }
});

test('every overlay key already exists in the base dictionary — no key is added', () => {
  for (const { vertical, locale, overlay } of overlayEntries()) {
    const baseFlat = flatten(dictionaries[locale] as Record<string, unknown>);
    for (const key of Object.keys(flatten(overlay as Record<string, unknown>))) {
      expect(key in baseFlat, `${vertical}/${locale}: overlay key "${key}" does not exist in base — a typo is a silent no-op`).toBe(true);
    }
  }
});

test('overlays REPLACE leaves and leave everything else untouched', () => {
  const en = dictionaries.en;
  const merged = applyVerticalOverlay(en, 'en', 'MARKETING');
  // Replaced.
  expect((merged.candidates as { title: string }).title).toBe('Leads');
  expect((merged.nav as { candidates: string }).candidates).toBe('Leads');
  // Untouched sibling in the same namespace.
  expect((merged.candidates as { assigned: string }).assigned).toBe((en.candidates as { assigned: string }).assigned);
  // A whole other namespace is the same reference (deep-merge only copies the touched path).
  expect(merged.common).toBe(en.common);
  // Base is never mutated.
  expect((en.candidates as { title: string }).title).toBe('Candidates');
});

// The machine-checkable half of #2426/#2427's acceptance ("no mentorship word
// is left on /admin/companies or the board"). The e2e proves what the browser
// paints; this proves the same thing for every key of the namespaces those two
// screens own, in all three locales — including the ones only a dialog or a
// hover card renders, which no innerText assertion can reach while it is shut.
// A new key added to any of these namespaces is checked the day it lands.
const SCREEN_NAMESPACES = [
  // /admin/companies: the page, its create/edit dialog, its entitlements
  // dialog, its day-one empty state.
  'companiesPage',
  'companyForm',
  'entitlements',
  'emptyStates.companies',
  // The stage board: the page, and the person hover card on every card's
  // owner chip. `emptyStates.board.adminBody` by key, not namespace — its
  // sibling `mentorBody` belongs to /mentor/board, a surface these two issues
  // do not cover (it still reads "mentees", deliberately).
  'board',
  'adminBoard',
  'emptyStates.board.adminBody',
  'personCard',
];

const MENTORSHIP_WORDS = /mentee|mentor|internship|staj|praktik/i;

test('no MARKETING string on /admin/companies or the board reads like the internship product', () => {
  for (const locale of ['en', 'tr', 'de'] as const) {
    const merged = applyVerticalOverlay(dictionaries[locale], locale, 'MARKETING');
    const flat = flatten(merged as unknown as Record<string, unknown>);
    for (const ns of SCREEN_NAMESPACES) {
      const keys = Object.keys(flat).filter((k) => k === ns || k.startsWith(`${ns}.`));
      expect(keys.length, `${locale}: "${ns}" matched no key — the namespace was renamed or removed`).toBeGreaterThan(0);
      for (const key of keys) {
        expect(
          MENTORSHIP_WORDS.test(String(flat[key])),
          `${locale}: ${key} = "${String(flat[key])}" still names the internship product to a MARKETING tenant`
        ).toBe(false);
      }
    }
  }
});

test('each locale that carries a MARKETING override localizes it, not a copy of English', () => {
  const tr = applyVerticalOverlay(dictionaries.tr, 'tr', 'MARKETING');
  // "Fırsat" is reserved for the deal/pipeline concept (#2498); the person list is
  // "Müşteri Adayları", not a literal translation of the English "Leads" override.
  expect((tr.candidates as { title: string }).title).toBe('Müşteri Adayları');
});
