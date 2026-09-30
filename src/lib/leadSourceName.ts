// Which `Source` a lead is attributed to, from what the lead arrived with (#2570).
//
// ZERO imports, so the rule is unit-tested without Next or a database
// (scripts/test/lead-source-name.test.mjs). The Prisma half — finding or
// creating the row inside the right tenant — is src/lib/leadSource.ts.
//
// ── THE INPUTS ───────────────────────────────────────────────────────────────
//
//   • `reference`          — an affiliate code (SaleVali `User.reference`).
//   • `utmSource/Medium/Campaign` — the campaign parameters a browser carried
//                            (the marketing demo form stores them raw on
//                            CompanyInquiry, #2569; an ingest carries them too).
//   • `acquisitionSource`  — the self-reported channel SaleVali asks for at
//                            sign-up (`User.acquisition_source`, one of
//                            ACQUISITION_SOURCES below).
//
// ── THE PRIORITY: affiliate reference > utm_source > acquisition_source > unknown
//
//   An affiliate code is a contract — somebody is paid per converted lead — so
//   it wins over everything, including a campaign the same visitor also
//   clicked. A UTM is what the browser measured; the self-reported channel is
//   what the person remembers, and loses to a measurement. Nothing at all is
//   `unknown`.
//
// ── THE NAMES (a decision, recorded here because names are data) ─────────────
//
//   affiliate:<code>                 one Source per affiliate, so the trial →
//                                    paid rate can be read PER AFFILIATE — the
//                                    reason the reference is attributed at all.
//                                    The code keeps its case (codes are
//                                    identifiers someone was handed).
//   utm:<source>/<medium>/<campaign> lower-cased; a missing medium or campaign
//                                    is `-`, so `google/-/spring` and
//                                    `google/spring` can never be confused.
//                                    Medium is IN the name on purpose: google
//                                    `cpc` and google `organic` are the paid-vs-
//                                    free question the budget is decided on.
//                                    utm_term/utm_content are not: they are
//                                    per-ad detail and would make a Source per
//                                    keyword.
//   channel:<acquisition_source>     one of the six values, verbatim.
//
//   A `/` inside a value becomes `-` (the separator stays unambiguous), control
//   characters are removed, whitespace runs collapse. Every segment is capped so
//   the whole name stays within SOURCE_NAME_MAX, the limit the admin form uses.
//
//   UNKNOWN IS NOT A SOURCE ROW. The result is `{ kind: 'unknown' }` and the
//   caller leaves `sourceId` NULL, so the lead lands in the explicit
//   `unsourced` bucket of the attribution report
//   (/api/admin/analytics/sources). A Source named "unknown" would be a second
//   "we don't know" bucket next to that one, and the report's honesty number
//   would be split across two rows. Deviation from the issue text, which lists
//   `unknown` as the last step of the priority: the step exists, it just maps
//   to NULL rather than to a row.
//
//   An acquisition_source outside the six is unknown too, not `channel:other`:
//   `other` is a real answer somebody picked, and folding a contract drift into
//   it would hide the drift.

export const ACQUISITION_SOURCES = [
  'search_engine',
  'social_media',
  'youtube',
  'referral',
  'advertisement',
  'other',
] as const;
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number];

/** The longest Source name any writer produces (the admin form's own limit). */
export const SOURCE_NAME_MAX = 120;
const AFFILIATE_CODE_MAX = 100;
const UTM_SEGMENT_MAX = 36;

export interface LeadSourceInput {
  reference?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  acquisitionSource?: string | null;
}

export type LeadSourceResult =
  | { kind: 'affiliate' | 'utm' | 'channel'; name: string }
  | { kind: 'unknown' };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const v = value.replace(CONTROL, ' ').replace(/\//g, '-').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return v || null;
}

/** The Source name for a lead, by the priority and naming rules above. */
export function leadSourceName(input: LeadSourceInput): LeadSourceResult {
  const reference = clean(input.reference, AFFILIATE_CODE_MAX);
  if (reference) return { kind: 'affiliate', name: `affiliate:${reference}` };

  const source = clean(input.utmSource, UTM_SEGMENT_MAX)?.toLowerCase();
  if (source) {
    const medium = clean(input.utmMedium, UTM_SEGMENT_MAX)?.toLowerCase() ?? '-';
    const campaign = clean(input.utmCampaign, UTM_SEGMENT_MAX)?.toLowerCase() ?? '-';
    return { kind: 'utm', name: `utm:${source}/${medium}/${campaign}` };
  }

  const channel = clean(input.acquisitionSource, 40)?.toLowerCase();
  if (channel && (ACQUISITION_SOURCES as readonly string[]).includes(channel)) {
    return { kind: 'channel', name: `channel:${channel}` };
  }

  return { kind: 'unknown' };
}

/**
 * A Source name TYPED by a person (the `source` column of the marketing
 * import, the manual lead form): kept as written — it is a partner's or an
 * event's name, not a machine value to normalise — but cleaned the same way
 * and capped at SOURCE_NAME_MAX. Null when nothing is left.
 */
export function typedSourceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, SOURCE_NAME_MAX).trim();
  return v || null;
}
