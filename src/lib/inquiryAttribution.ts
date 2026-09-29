// Where a public enquiry came from — campaign parameters and referrer (#2569).
//
// ZERO imports, so the rule is unit-tested without Next or a database
// (scripts/test/inquiry-attribution.test.mjs). The values are stored RAW on the
// CompanyInquiry row; mapping them onto a `Source` is #2570's job, so nothing
// here interprets a campaign name.
//
// Everything below arrives from an unauthenticated browser, so each value is
// bounded and cleaned rather than trusted:
//   • UTM values: trimmed, control characters removed, capped at
//     UTM_VALUE_MAX characters. An empty value is absent, not "".
//   • The referrer: only an absolute http(s) URL is kept, and only its origin
//     and path — the QUERY STRING AND FRAGMENT ARE DROPPED, because a referring
//     page's query is where other sites put e-mail addresses, session tokens and
//     search terms, none of which this product has any business storing. A
//     referrer on the receiving host itself is the visitor clicking around our
//     own site, not a source, and is dropped too.

export const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];

export const UTM_VALUE_MAX = 150;
export const REFERRER_MAX = 500;

export interface InquiryAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrer: string | null;
}

const COLUMN: Record<UtmKey, keyof InquiryAttribution> = {
  source: 'utmSource',
  medium: 'utmMedium',
  campaign: 'utmCampaign',
  term: 'utmTerm',
  content: 'utmContent',
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function cleanUtm(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.replace(CONTROL, '').trim().slice(0, UTM_VALUE_MAX).trim();
  return v || null;
}

/**
 * The referrer as stored: origin + path of an absolute http(s) URL, or null.
 * `receivedHost` is the bare hostname the request arrived on; a referrer on it
 * is internal navigation and is not a source.
 */
export function cleanReferrer(value: unknown, receivedHost: string | null): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (receivedHost && url.hostname.toLowerCase() === receivedHost.toLowerCase()) return null;
  const kept = `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
  return kept.slice(0, REFERRER_MAX);
}

/** Every attribution column for one enquiry, from the posted body. */
export function readInquiryAttribution(
  input: { utm?: Partial<Record<string, unknown>> | null; referrer?: unknown },
  receivedHost: string | null,
): InquiryAttribution {
  const out: InquiryAttribution = {
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    referrer: cleanReferrer(input.referrer, receivedHost),
  };
  const utm = input.utm && typeof input.utm === 'object' ? input.utm : {};
  for (const key of UTM_KEYS) {
    const v = cleanUtm(utm[key]);
    if (v) out[COLUMN[key]] = v;
  }
  return out;
}

/**
 * The browser half: the `utm_*` parameters of a query string, as the object the
 * form posts. Unknown parameters are ignored; the server cleans the values.
 */
export function utmFromSearch(search: string): Partial<Record<UtmKey, string>> {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const out: Partial<Record<UtmKey, string>> = {};
  for (const key of UTM_KEYS) {
    const v = params.get(`utm_${key}`);
    if (v) out[key] = v.slice(0, UTM_VALUE_MAX * 2);
  }
  return out;
}
