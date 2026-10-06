// Contact-detail masking for free text sent to a model (#1910) — pure, no
// provider, unit-tested (scripts/test/survey-text-rules.test.mjs). A
// respondent may type their own e-mail, phone number or a link into a
// free-text box, and no summary needs any of them.
//
// Since #2046 part 2 the survey summary runs on the open-text engine
// (src/lib/ai/openTextRules.ts), which applies this masking to every row and
// owns what comes back (verbatim quotes, verified themes).

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
// Seven or more digits, allowing the separators people type in a number.
const PHONE = /\+?\d[\d\s()./-]{5,}\d/g;

export const MAX_SUMMARY_INPUT_CHARS = 24_000;

/** Mask what identifies a person directly; keep everything else as typed. */
export function redactAnswerText(text: string): string {
  return text.replace(EMAIL, '[e-mail]').replace(URL_RE, '[link]').replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 7 ? '[phone]' : m));
}
