// CI guard for i18n dictionary integrity (EN/TR/DE). TypeScript already enforces
// key parity via the `Dict` type, so this is defense-in-depth that ALSO catches
// what the type can't: empty / whitespace-only translations, and reports any
// drift with a clear, actionable message. Run with Node's TS stripping:
//   node --experimental-strip-types scripts/check-i18n.ts
import { dictionaries } from '../src/i18n/dictionaries.ts';
import { overlayEntries, applyVerticalOverlay } from '../src/i18n/verticalOverlays.ts';
import type { Locale } from '../src/i18n/config.ts';

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

// An overlay REPLACES a sentence the code interpolates, so it must carry the
// same {placeholders} as the base value: a dropped `{menteeName}` would print
// a sentence with a hole, an added one a literal "{x}" (#2558).
const placeholderSet = (s: string) => [...new Set([...s.matchAll(/\{[a-zA-Z]+\}/g)].map((m) => m[0]))].sort().join(' ');
for (const { vertical, locale, overlay } of overlayEntries()) {
  const base = flatten(dictionaries[locale as keyof typeof dictionaries] as AnyRec);
  for (const [k, v] of Object.entries(flatten(overlay as AnyRec))) {
    if (base[k] !== undefined && placeholderSet(base[k]) !== placeholderSet(v)) {
      errors.push(`[overlay ${vertical}/${locale}] ${k} has placeholders {${placeholderSet(v)}} but the base has {${placeholderSet(base[k])}}`);
    }
  }
}

// ---------------------------------------------------------------------------
// MARKETING terminology leak ratchet (#2558, story #2394 KK-2).
//
// A MARKETING tenant must not read the internship product's words. This
// counts, per locale, the overlay-RESOLVED MARKETING values that still contain
// one, and pins the count. It is a RATCHET, not a to-do list: the literal
// below is the one number to move, and it may only go down —
//   • more leaks than the literal  → exit 1 (a new "mentor" string reached a
//     namespace MARKETING renders without an overlay entry);
//   • fewer leaks than the literal → exit 1 too, so whoever removed some
//     lowers the literal in the same diff and nobody can later spend the slack.
// `npm run check:i18n -- --leaks` (optionally `--leaks=tr`) lists the keys.
//
// What is NOT a leak, and therefore never counted:
//   • a {placeholder} — `{menteeName}` is an interpolation slot the reader
//     never sees;
//   • the ROLE ENUM spelled as an enum (MENTOR / MENTEE in capitals) — the
//     CSV import's role column accepts exactly those tokens, and #2558 keeps
//     the enum and renames only its labels;
//   • a namespace in LEAK_EXEMPT below, each with the reason MARKETING cannot
//     render it. Anything not listed there counts, including the landing's
//     internship-only sections — an exemption must be argued, not assumed.
const LEAK_WORDS: Record<string, RegExp> = {
  // "internal" is not the internship product.
  en: /mentor|mentee|intern(?!al)/i,
  // German "intern" means internal, and "Mentoring" is caught by /mentor/.
  de: /mentor|mentee|praktik|internship/i,
  tr: /mentor|mentör|mentee|staj|internship/i,
};

const LEAK_EXEMPT: Record<string, string> = {
  portal: 'The mentee portal shell: src/app/portal/layout.tsx redirects every org without the `mentorship` capability to /account.',
  portalInsights: 'Rendered only inside /portal (see `portal`).',
  mentorAnalytics: 'Read only by the mentor shell (src/app/mentor), whose layout sends a MARKETING MENTOR to /sales.',
  offers: 'Offer management — `/api/offers` refuses an org without the `placements` capability (requireCapability).',
  offersAdmin: 'The admin offer screen over the same `placements`-gated API.',
  offerEmail: 'Sent only by src/lib/offerNotify.ts, i.e. by the `placements`-gated offer API.',
};

// The pinned counts. Lower them when a change removes leaks; never raise them
// — a new leak is fixed with an overlay entry (src/i18n/verticalOverlays.ts),
// or argued into LEAK_EXEMPT with its reason. History: 528/530/526 (en/tr/de)
// on the day the ratchet landed, before #2557/#2558's own overlay entries.
const EXPECTED_LEAKS: Record<string, number> = { en: 414, tr: 417, de: 412 };

const leakArg = process.argv.find((a) => a === '--leaks' || a.startsWith('--leaks='));
const listLocale = leakArg ? (leakArg.split('=')[1] ?? 'all') : null;

for (const loc of locales) {
  const resolved = flatten(
    applyVerticalOverlay(dictionaries[loc as keyof typeof dictionaries] as AnyRec, loc as Locale, 'MARKETING') as AnyRec,
  );
  const leaks = Object.entries(resolved).filter(([k, v]) => {
    if (LEAK_EXEMPT[k.split('.')[0]]) return false;
    const visible = v.replace(/\{[a-zA-Z]+\}/g, '').replace(/\bMENT(?:OR|EE)S?\b/g, '');
    return LEAK_WORDS[loc].test(visible);
  });
  if (listLocale === 'all' || listLocale === loc) {
    for (const [k, v] of leaks) console.log(`[leak ${loc}] ${k}: ${v}`);
  }
  const expected = EXPECTED_LEAKS[loc];
  if (leaks.length > expected) {
    errors.push(
      `[leak ${loc}] ${leaks.length} MARKETING-visible values contain internship words, the ratchet allows ${expected}. ` +
        `Add a MARKETING overlay entry for the new string (src/i18n/verticalOverlays.ts); run with --leaks=${loc} to list them.`,
    );
  } else if (leaks.length < expected) {
    errors.push(
      `[leak ${loc}] only ${leaks.length} leaks left, the ratchet still allows ${expected} — lower EXPECTED_LEAKS.${loc} in scripts/check-i18n.ts to ${leaks.length} in this diff.`,
    );
  }
}

if (errors.length > 0) {
  console.error(`i18n check FAILED — ${errors.length} issue(s):`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}

console.log(`i18n OK — ${baseKeys.length} keys × ${locales.length} locales (${locales.join(', ')})`);
console.log(
  `MARKETING leak ratchet at ${locales.map((l) => `${l} ${EXPECTED_LEAKS[l]}`).join(' · ')} (#2558; --leaks to list)`,
);
