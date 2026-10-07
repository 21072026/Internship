// The PII pre-flight (#2026) — pure, unit-tested in
// scripts/test/ai-untrusted.test.mjs.
//
// `callModel()` runs this over every untrusted block (src/lib/ai/untrusted.ts)
// of a task whose registry entry does not declare `needsContactDetails`
// (src/lib/ai/tasks.ts). Today only `cv_extract` does — its whole point is to
// read the phone number and profile links off a CV. CV feedback, interaction
// summaries, conversation catch-ups and the rest need none of them, so none of
// them leave the building.
//
// What is masked, and the token it becomes:
//   e-mail addresses          → [e-mail]
//   http(s)/www URLs          → [link]     (a URL can carry a token or a name)
//   phone numbers             → [phone]    (international +/00, or national 0…)
//   IBANs                     → [iban]
//   11-digit ID-shaped numbers → [id]      (German Steuer-ID, Turkish TC Kimlik)
//   street + house number     → [address]  (DE/TR/EN shapes, optional postcode + city)
//
// Tuned AGAINST false positives on what a CV is full of: years and date
// ranges ("2019 – 2021", "03/2020 – 05/2022"), percentages, version numbers.
// A heuristic, not a guarantee — it narrows what leaves, the consent and the
// fence are still what the call rests on. Idempotent: its own tokens never
// match again, so running it twice changes nothing (the open-text engine
// relies on that — its rows are pre-masked with this same function so the
// verbatim-quote check compares like with like).

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
const ID_11 = /(?<![\d.,/-])\d{11}(?![\d.,/-])/g;
// +49 171 1234567, 0049 (0)30 1234567, +90 532 123 45 67
const PHONE_INTL = /(?<![\w+])(?:\+|00)[1-9][\d\s().\/-]{6,20}\d/g;
// 0171 1234567, 030/1234567, 0532 123 45 67 — no dots, so dd.mm.yyyy never matches.
const PHONE_NATIONAL = /(?<![\w.,/])0[1-9][\d\s()\/-]{6,18}\d/g;
// mm/yyyy or a year range inside a candidate: a date, not a phone number.
const DATE_INSIDE = /\b(?:0?[1-9]|1[0-2])\/(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\s*[-–]\s*(?:0?[1-9]\/)?(?:19|20)\d{2}\b/;

const L = 'A-Za-zÀ-ÖØ-öø-ÿĀ-žĞğİıŞş';
// "Hauptstraße 12", "Berliner Str. 5a", "Am Mühlenweg 3", "Lindenallee 12, 10115 Berlin"
const STREET_DE = new RegExp(`(?<![${L}])(?:[${L}][${L}'-]*\\s+)?(?:[${L}][${L}'-]*)?(?:straße|strasse|str\\.|weg|allee|gasse|damm|ufer|chaussee|platz)\\s+\\d{1,3}[a-zA-Z]?(?!\\d)(?:,?\\s*(?:D-)?\\d{5}\\s+[${L}][${L}-]+)?`, 'gi');
// "Atatürk Cad. No: 12", "Gül Sokak No:5", "Çiçek Sk. 7"
const STREET_TR = new RegExp(`(?<![${L}])[${L}][${L}'-]*\\s+(?:cadde(?:si)?|cad\\.|cd\\.|sokak|sokağı|sok\\.|sk\\.|bulvarı|blv\\.)\\s*(?:no\\s*:?\\s*)?\\d{1,3}[a-zA-Z]?(?!\\d)`, 'gi');
// "221 Baker Street", "12 Elm Road"
const STREET_EN = new RegExp(`\\b\\d{1,4}[a-zA-Z]?\\s+(?:[${L}]+\\s+){1,3}(?:Street|St\\.|Road|Rd\\.|Avenue|Ave\\.|Lane|Drive|Boulevard)\\b`, 'g');

export type RedactionKind = 'email' | 'link' | 'phone' | 'iban' | 'id' | 'address';

const digits = (s: string) => s.replace(/\D/g, '').length;

/** `text` with contact details masked, plus which kinds were found (for tests and logs — never the values). */
export function redactForPromptDetailed(text: string): { text: string; kinds: RedactionKind[] } {
  const kinds = new Set<RedactionKind>();
  const mark = (kind: RedactionKind, token: string) => () => {
    kinds.add(kind);
    return token;
  };
  let out = String(text ?? '');
  out = out.replace(EMAIL, mark('email', '[e-mail]'));
  out = out.replace(URL_RE, mark('link', '[link]'));
  out = out.replace(IBAN, (m) => (digits(m) >= 10 ? mark('iban', '[iban]')() : m));
  const phone = (min: number, max: number) => (m: string) => {
    const n = digits(m);
    if (n < min || n > max || DATE_INSIDE.test(m)) return m;
    kinds.add('phone');
    return '[phone]';
  };
  out = out.replace(PHONE_INTL, phone(8, 15));
  out = out.replace(PHONE_NATIONAL, phone(9, 13));
  out = out.replace(ID_11, mark('id', '[id]'));
  out = out.replace(STREET_DE, mark('address', '[address]'));
  out = out.replace(STREET_TR, mark('address', '[address]'));
  out = out.replace(STREET_EN, mark('address', '[address]'));
  return { text: out, kinds: [...kinds] };
}

export function redactForPrompt(text: string): string {
  return redactForPromptDetailed(text).text;
}
