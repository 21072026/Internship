// Accept-Language → one of our locales (#1384). ZERO imports on purpose, so
// `node --test --experimental-strip-types` can load it without a resolve hook
// (scripts/test/accept-language.test.mjs); the supported list is passed in.
//
// WHY: the primary audience reads Turkish and the second German, yet every
// first visit opened in English — a visitor from a Turkish post or ad had to
// find a three-letter switch in the header before the landing's copy could do
// its job. The browser has already said which languages its user reads.
//
// THE RULE (RFC 9110 §12.5.4, the parts that matter here):
//   - entries are `tag[;q=value]`, comma-separated; q defaults to 1, q=0 means
//     "not acceptable", a malformed q drops the entry rather than the header;
//   - `tr-TR` / `de-AT` match on their primary subtag, so a regional variant
//     reaches the language we have;
//   - highest q wins; on a tie the earlier entry wins (header order is the
//     user's order);
//   - `*` means "anything" and so chooses nothing — the caller's default
//     applies, exactly as for an empty, missing or garbage header.
//
// This decides a READ only. Nothing here writes the locale cookie: the cookie
// stays the record of an explicit choice (the language switcher), and the
// header is re-read on every request anyway.

const MAX_HEADER = 1024;

export function pickAcceptLanguage<L extends string>(
  header: string | null | undefined,
  supported: readonly L[],
): L | null {
  if (!header) return null;
  // A header is a few dozen bytes; anything longer is not a browser's.
  const raw = header.length > MAX_HEADER ? header.slice(0, MAX_HEADER) : header;
  let best: { locale: L; q: number; index: number } | null = null;
  const entries = raw.split(',');
  for (let index = 0; index < entries.length; index++) {
    const [tagPart, ...params] = entries[index].trim().split(';');
    const tag = tagPart.trim().toLowerCase();
    if (!tag || tag === '*') continue;
    let q = 1;
    let valid = true;
    for (const param of params) {
      const [key, value] = param.split('=').map((s) => s.trim().toLowerCase());
      if (key !== 'q') continue;
      if (!value || !/^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(value)) {
        valid = false;
        break;
      }
      q = Number(value);
    }
    if (!valid || q <= 0) continue;
    const primary = tag.split('-')[0];
    const locale = supported.find((l) => l.toLowerCase() === primary);
    if (!locale) continue;
    if (!best || q > best.q) best = { locale, q, index };
  }
  return best?.locale ?? null;
}
