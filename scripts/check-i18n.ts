// CI guard for i18n dictionary integrity (EN/TR/DE). TypeScript already enforces
// key parity via the `Dict` type, so this is defense-in-depth that ALSO catches
// what the type can't: empty / whitespace-only translations, and reports any
// drift with a clear, actionable message. Run with Node's TS stripping:
//   node --experimental-strip-types scripts/check-i18n.ts
import { dictionaries } from '../src/i18n/dictionaries.ts';

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

if (errors.length > 0) {
  console.error(`i18n check FAILED — ${errors.length} issue(s):`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}

console.log(`i18n OK — ${baseKeys.length} keys × ${locales.length} locales (${locales.join(', ')})`);
