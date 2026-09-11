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

test('each locale that carries a MARKETING override localizes it, not a copy of English', () => {
  const tr = applyVerticalOverlay(dictionaries.tr, 'tr', 'MARKETING');
  expect((tr.candidates as { title: string }).title).toBe('Fırsatlar');
});
