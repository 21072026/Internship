// CI guard for i18n dictionary integrity (EN/TR/DE). TypeScript already enforces
// key parity via the `Dict` type, so this is defense-in-depth that ALSO catches
// what the type can't: empty / whitespace-only translations, and reports any
// drift with a clear, actionable message. Run with Node's TS stripping:
//   node --experimental-strip-types scripts/check-i18n.ts
import { dictionaries } from '../src/i18n/dictionaries.ts';
import { overlayEntries } from '../src/i18n/verticalOverlays.ts';

type AnyRec = Record<string, unknown>;

function flatten(obj: AnyRec, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v as AnyRec, key));
    } else {
      out[key] = String(v);
    }
  }
  return out;
}

const locales = Object.keys(dictionaries);
const BASE = 'en';
const baseFlat = flatten(dictionaries[BASE as keyof typeof dictionaries] as AnyRec);
const baseKeys = Object.keys(baseFlat);
const baseKeySet = new Set(baseKeys);
const errors: string[] = [];

for (const loc of locales) {
  const flat = flatten(dictionaries[loc as keyof typeof dictionaries] as AnyRec);
  const keySet = new Set(Object.keys(flat));
  for (const k of baseKeys) if (!keySet.has(k)) errors.push(`[${loc}] missing key: ${k}`);
  for (const k of keySet) if (!baseKeySet.has(k)) errors.push(`[${loc}] extra key: ${k}`);
  for (const [k, v] of Object.entries(flat)) {
    if (v.trim() === '') errors.push(`[${loc}] empty value: ${k}`);
  }
}

// Vertical terminology overlays (#2354): every override must target a key that
// already exists in the base (a typo would be a silent no-op — TypeScript also
// catches this, but the guard states it independently), and INTERNSHIP must
// override nothing (its emptiness is the no-op guarantee for today's product).
for (const { vertical, locale, overlay } of overlayEntries()) {
  const overlayKeys = Object.keys(flatten(overlay as AnyRec));
  if (vertical === 'INTERNSHIP' && overlayKeys.length > 0) {
    errors.push(`[overlay ${vertical}/${locale}] INTERNSHIP must override nothing, found: ${overlayKeys.join(', ')}`);
  }
  const localeBaseKeys = new Set(Object.keys(flatten(dictionaries[locale as keyof typeof dictionaries] as AnyRec)));
  for (const k of overlayKeys) {
    if (!localeBaseKeys.has(k)) errors.push(`[overlay ${vertical}/${locale}] key not in base dictionary: ${k}`);
  }
}

if (errors.length > 0) {
  console.error(`i18n check FAILED — ${errors.length} issue(s):`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}

console.log(`i18n OK — ${baseKeys.length} keys × ${locales.length} locales (${locales.join(', ')})`);
