import type { CompensationFields } from './compensation';

// The offer letter rule (#1857) — dependency-free, so the admin editor's live
// preview, the server render and the unit test run the exact same code.
//
// A template is markdown in the subset certificatePdf.ts draws (#/##/###,
// "- " bullets, paragraphs). Merge tags are an ALLOWLIST: `{{name}}` is
// replaced only when `name` is in MERGE_TAGS; anything else — `{{foo}}`,
// `{{ position }}` with spaces, `{{constructor}}` — is left exactly as typed.
// Nothing is evaluated: the replacement is a lookup into a plain object built
// from the allowlist, never a property read on caller data.
//
// The rendered text is FROZEN on the offer when it is sent
// (`Offer.letterSnapshot`); a later template edit never rewrites a letter a
// person has already been shown. Accepting records a click-to-accept record
// (time, IP, user agent) — NOT a qualified electronic signature (eIDAS QES),
// and nothing here may claim it is.

export const MERGE_TAGS = [
  'candidateName',
  'position',
  'companyName',
  'startDate',
  'compensation',
  'expiresAt',
  'programName',
] as const;
export type MergeTag = (typeof MERGE_TAGS)[number];
export type MergeValues = Record<MergeTag, string>;

const TAG_RE = /\{\{([A-Za-z]+)\}\}/g;
const ALLOWED: ReadonlySet<string> = new Set(MERGE_TAGS);

/** Body length ceiling for a stored template (a letter, not a book). */
export const OFFER_TEMPLATE_MAX = 20_000;

export function renderOfferLetter(bodyMarkdown: string, values: MergeValues): string {
  return bodyMarkdown.replace(TAG_RE, (whole, name: string) =>
    ALLOWED.has(name) ? values[name as MergeTag] : whole,
  );
}

/** Tags a template uses that the allowlist does not know — shown as a warning in the editor. */
export function unknownMergeTags(bodyMarkdown: string): string[] {
  const out = new Set<string>();
  for (const m of bodyMarkdown.matchAll(TAG_RE)) if (!ALLOWED.has(m[1])) out.add(m[1]);
  return [...out];
}

// Standard 14 PDF fonts are WinAnsi-encoded: they cannot draw ğ, ş, ı, İ, Ğ, Ş
// (pdf-lib throws on them), while ä/ö/ü/ß/ç are fine. A letter must never fail
// to download over a Turkish name, so letters the font cannot carry are folded
// to their base letter and anything else outside WinAnsi becomes "?". The
// on-screen letter (the snapshot itself) keeps every character.
const FOLD: Record<string, string> = { 'ğ': 'g', 'Ğ': 'G', 'ş': 's', 'Ş': 'S', 'ı': 'i', 'İ': 'I' };
// WinAnsi (cp1252) beyond Latin-1: the printable characters in 0x80–0x9F.
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

export function pdfSafeText(text: string): string {
  let out = '';
  for (const ch of text) {
    if (FOLD[ch]) { out += FOLD[ch]; continue; }
    const code = ch.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRA.has(ch)) {
      out += ch;
    } else {
      out += '?';
    }
  }
  return out;
}

/** The sample values the admin preview renders with. */
export function sampleMergeValues(locale: 'en' | 'tr' | 'de'): MergeValues {
  const sample = {
    en: { candidateName: 'Alex Example', startDate: '1 March 2027', compensation: 'EUR 2,400.00 per month', expiresAt: '15 February 2027' },
    tr: { candidateName: 'Deniz Örnek', startDate: '1 Mart 2027', compensation: 'Aylık 2.400,00 EUR', expiresAt: '15 Şubat 2027' },
    de: { candidateName: 'Kim Beispiel', startDate: '1. März 2027', compensation: '2.400,00 EUR pro Monat', expiresAt: '15. Februar 2027' },
  }[locale];
  return { ...sample, position: 'Junior Developer', companyName: 'Acme Sales', programName: 'Example Programme' };
}

/** The labels compensationLine() needs — `t.offers.compensation` on either side. */
export interface CompensationLabels {
  perPeriod: Record<string, string>;
  hoursPerWeek: string;
  signingBonus: string;
  otherBonus: string;
  equity: string;
}

/**
 * The {{compensation}} value: the structured figures, then the free-text note.
 * `money` is formatMinorAmount bound to the reader's locale (src/lib/money.ts)
 * — passed in so this module stays dependency-free.
 */
export function compensationLine(
  offer: Partial<CompensationFields> & { compensationNote?: string | null },
  c: CompensationLabels,
  money: (amountMinor: number, currency: string) => string,
): string {
  const parts: string[] = [];
  if (offer.baseAmountMinor != null && offer.currency) {
    const period = offer.basePeriod ? c.perPeriod[offer.basePeriod] ?? offer.basePeriod : '';
    parts.push(`${money(offer.baseAmountMinor, offer.currency)}${period ? ` ${period}` : ''}`);
  }
  if (offer.hoursPerWeek != null) parts.push(c.hoursPerWeek.replace('{n}', String(offer.hoursPerWeek)));
  if (offer.signingBonusMinor != null && offer.currency) {
    parts.push(c.signingBonus.replace('{amount}', money(offer.signingBonusMinor, offer.currency)));
  }
  if (offer.otherBonusMinor != null && offer.currency) {
    parts.push(c.otherBonus.replace('{amount}', money(offer.otherBonusMinor, offer.currency)));
  }
  if (offer.equityNote) parts.push(c.equity.replace('{note}', offer.equityNote));
  if (offer.compensationNote?.trim()) parts.push(offer.compensationNote.trim());
  return parts.join(' · ') || '—';
}
