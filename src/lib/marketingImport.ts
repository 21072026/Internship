// Marketing account import: the column contract, the match key and the diff.
//
// WHAT THIS IS (#2404/#2405/#2406/#2407, story #2391)
//   The marketing team still keeps its customer base in a spreadsheet. This is
//   the half of the importer that decides *what every row means* — which
//   existing account it is, what it would write, and whether that is a CREATE,
//   an UPDATE, an UNCHANGED or a SKIP. `src/lib/marketingImportStore.ts` is the
//   only half that knows about Prisma, and `scripts/import-marketing-accounts.mjs`
//   is the operator's entry point.
//
//   There is NO second parser and NO second dry-run engine: the table comes from
//   `parseDelimited()` and the run is `runImport({ parse, validate, resolve,
//   apply })` — both in `src/lib/importPreview.ts`, both shared with the roster
//   feed (docs/roster-feed.md). A dry run is the same call with a writer that
//   does not write, so nothing here is planned in an `if (dryRun)` branch.
//
// WHAT A ROW BECOMES (docs/marketing-vertical/pipeline-record.md)
//   • the ACCOUNT is a `Company` row — master data, one per merchant;
//   • the FUNNEL RECORD is a `MentorshipRelation` — owner = `mentorId`, lead
//     person = `menteeId`, account = `companyId`. It is the only carrier the
//     board, the stage SLAs, the aging report and `StatusChange` already know,
//     and this backlog adds no second one;
//   • the LEAD PERSON is the row's primary contact as a `User` with role
//     MENTEE — password-less (`NO_LOGIN_PASSWORD`), never invited, exactly the
//     record the mentor-entered mentee and the public application already mint.
//
//   A row with a stage but no contact e-mail therefore cannot be placed on the
//   funnel (the relation's `menteeId` is a required FK). Its Company is still
//   written and the row carries a warning — losing the account because nobody
//   typed a contact would be the worse failure.
//
// THE MATCH KEY (#2405, #2554)
//   The external id first — the merchant's id in the product the tenant sells,
//   which can confirm the other keys but never be overruled by them (a
//   disagreement is an ERROR on the row, see `matchAccount`). Then the VAT id —
//   the strongest identity a merchant has across systems — then
//   normalized name + country. `normalizeNameKey()` is the repo's existing one
//   (`src/lib/duplicateDetection.ts`): it transliterates İ/ı/ş/ğ/ü/ö/ç and
//   strips accents BEFORE lowercasing, which a plain `toLowerCase()` cannot do
//   ('İ'.toLowerCase() is two code points). Country is the other half because
//   `address` is free text and two merchants of the same name in two countries
//   were otherwise one row.
//
// Dependency-free apart from those two sibling modules, so the diff — the part
// where the bugs live — is unit-tested against plain arrays with an in-memory
// writer (`scripts/test/marketing-import.test.mjs`).
import {
  headerIndex,
  importErrorMessage,
  type ParsedRow,
  type ParsedTable,
  type PlannedRow,
  type ResolveResult,
  type RowResult,
  type ValidatedRow,
} from './importPreview';
import { normalizeEmailKey, normalizeNameKey, normalizePhoneKey } from './duplicateDetection';
import { isPlaceholderEmail, PLACEHOLDER_EMAIL_DOMAIN } from './menteeAccount';
import { planFieldUpdates } from './externalSyncPolicy';
import { typedSourceName } from './leadSourceName';
import { TEXT_LIMITS } from './textLimits';
import {
  DEFAULT_TRIAL_LENGTH_DAYS,
  TRIAL_ACTIVE_STAGE_KEY,
  trialWindowFor,
  type ExistingTrialWindow,
  type TrialWindowData,
} from './trialReminderRule';

// ── The column contract ──────────────────────────────────────────────────────
// One declaration, read by the validator, printed by the CLI and written out
// column by column in docs/marketing-import.md. `aliases` exist because the
// source file is a German/Turkish export: header lookup is already
// case/space-insensitive (`headerIndex`), these add the other spellings.
//
// There is deliberately NO tenant/org column. One run imports into ONE
// organization — the one that owns `--owner` — and a column that could name a
// different tenant would be a cross-tenant write with a spreadsheet as its
// authorization (docs/tenant-isolation.md).

export interface MarketingColumnSpec {
  /** The field name in the report and in this module's types. */
  field: string;
  /** The canonical header. */
  header: string;
  required: boolean;
  aliases: readonly string[];
  /** Where the value lands today; `null` means "no column yet" (see below). */
  target: string | null;
}

export const MARKETING_IMPORT_COLUMNS: readonly MarketingColumnSpec[] = [
  { field: 'name', header: 'name', required: true, aliases: ['company', 'firma', 'firma adi'], target: 'Company.name' },
  { field: 'legalName', header: 'legal_name', required: false, aliases: ['legal name', 'firmenname'], target: null },
  { field: 'country', header: 'country', required: false, aliases: ['land', 'ulke'], target: 'Company.country + User.country' },
  { field: 'city', header: 'city', required: false, aliases: ['stadt', 'sehir'], target: 'User.city (the lead)' },
  { field: 'vatId', header: 'vat_id', required: false, aliases: ['vat', 'ustid', 'vergi no'], target: 'Company.vatId' },
  { field: 'website', header: 'website', required: false, aliases: ['url', 'web'], target: null },
  { field: 'industry', header: 'industry', required: false, aliases: ['branche', 'sektor'], target: 'Company.industry' },
  { field: 'locale', header: 'locale', required: false, aliases: ['language', 'sprache', 'dil'], target: 'User.preferredLanguage' },
  { field: 'stage', header: 'stage', required: false, aliases: ['funnel_stage', 'status'], target: 'MentorshipRelation.pipelineStatus' },
  { field: 'source', header: 'source', required: false, aliases: ['quelle', 'kaynak'], target: 'User.referralSource' },
  { field: 'monthlyTransactions', header: 'monthly_transactions', required: false, aliases: ['transactions', 'bestellungen'], target: null },
  { field: 'mrr', header: 'mrr', required: false, aliases: ['monthly_revenue'], target: null },
  { field: 'ownerEmail', header: 'owner_email', required: false, aliases: ['owner', 'betreuer'], target: 'MentorshipRelation.mentorId' },
  { field: 'channels', header: 'channels', required: false, aliases: ['kanale', 'kanallar'], target: null },
  { field: 'contactName', header: 'contact_name', required: false, aliases: ['ansprechpartner'], target: 'Company.contactName + User.fullName' },
  { field: 'contactEmail', header: 'contact_email', required: false, aliases: ['email', 'e-mail'], target: 'Company.contactEmail + User.email' },
  { field: 'contactPhone', header: 'contact_phone', required: false, aliases: ['telefon', 'phone'], target: 'Company.contactPhone + User.phone' },
  // #2554. The account's id in the product the tenant sells — for SaleVali the
  // merchant's `User._id` (the key #2565 proposes; `user_number` is a display
  // number and is deliberately NOT an alias). It is the key the usage feed
  // matches on (docs/marketing-vertical/salevali-usage-feed.md), and the first
  // half of the match key below.
  {
    field: 'externalId',
    header: 'external_id',
    required: false,
    aliases: ['external id', 'externalid', 'salevali_id', 'salevali id', 'externe_id', 'externe id', 'harici_id', 'harici id'],
    target: 'Company.externalId',
  },
  // #2554. The funnel record's dates, so an imported trial is reminded about and
  // expires like any other, and the cohort reports read when the customer
  // arrived rather than the day of the import. ISO dates only (see
  // parseImportDate). A file date always wins over the automatic trial stamp.
  {
    field: 'trialStartedAt',
    header: 'trial_started_at',
    required: false,
    aliases: ['trial_start', 'trial start', 'testbeginn', 'test_beginn', 'deneme_baslangic', 'deneme başlangıç'],
    target: 'MentorshipRelation.trialStartedAt',
  },
  {
    field: 'trialEndsAt',
    header: 'trial_ends_at',
    required: false,
    aliases: ['trial_end', 'trial end', 'testende', 'test_ende', 'deneme_bitis', 'deneme bitiş'],
    target: 'MentorshipRelation.trialEndsAt',
  },
  {
    field: 'customerSince',
    header: 'customer_since',
    required: false,
    aliases: ['customer since', 'kunde_seit', 'kunde seit', 'musteri_tarihi', 'müşteri tarihi'],
    target: 'MentorshipRelation.startDate',
  },
];

/**
 * Columns the contract accepts, validates and reports — and that no column in
 * the schema holds yet. They are NOT silently dropped: they ride in the row's
 * `value`, so the run report (`--report`) is a complete record of the file and
 * the same file can be replayed once the column lands. Sales channels are
 * #2408; revenue/volume belong to the metering epic.
 */
export const MARKETING_COLUMNS_WITHOUT_TARGET: readonly string[] = MARKETING_IMPORT_COLUMNS.filter(
  (c) => c.target === null,
).map((c) => c.header);

/**
 * How long each field may be, per field, from the ONE source of truth
 * (`src/lib/textLimits.ts` — never an inline number, #1433/#2262). A value past
 * its column's width would pass validation here and die in the INSERT with
 * P2000, which surfaces as a 500; in a migration it would also mean an
 * operator's file was silently truncated, which is worse than a refused row.
 *
 * The fields with no database column yet are bounded by the generic
 * VARCHAR(191) default so the report cannot be flooded by a pasted paragraph.
 */
export const MAX_FIELD_LENGTH = 191;

/**
 * The most data rows one run of the admin panel may carry (#2552). The run is
 * one HTTP request that plans the whole file and writes one transaction per
 * row, so it is bounded like every other request; a larger table is split into
 * files. The CLI has no such cap (it is not a request).
 */
export const MARKETING_IMPORT_MAX_ROWS = 5000;

export const FIELD_LIMITS: Readonly<Record<string, number>> = {
  name: TEXT_LIMITS.companyName,
  country: TEXT_LIMITS.companyCountry,
  vatId: TEXT_LIMITS.companyVatId,
  industry: TEXT_LIMITS.companyIndustry,
  contactName: TEXT_LIMITS.companyContactName,
  contactEmail: TEXT_LIMITS.companyContactEmail,
  contactPhone: TEXT_LIMITS.companyContactPhone,
  // Written onto the lead `User`, so the profile's own caps apply.
  city: TEXT_LIMITS.profileShortText,
  source: TEXT_LIMITS.profileShortText,
  externalId: TEXT_LIMITS.companyExternalId,
};

// ── The typed row ────────────────────────────────────────────────────────────

export interface MarketingAccountRow {
  name: string;
  legalName: string;
  /** ISO-3166-1 alpha-2, upper case, or ''. */
  country: string;
  city: string;
  /** Normalized: upper case, separators stripped. '' when the row carries none. */
  vatId: string;
  website: string;
  industry: string;
  /** 'en' | 'tr' | 'de' or ''. */
  locale: string;
  /** A stage key of the org's OWN pipeline, or ''. */
  stage: string;
  source: string;
  monthlyTransactions: number | null;
  /** Minor units (cents). Integer only — src/lib/money.ts's convention. */
  mrrMinor: number | null;
  /** Lower-cased owner address, or '' meaning "the run's --owner". */
  ownerEmail: string;
  channels: string[];
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  /** The account's id in the tenant's product, as written (trimmed), or ''. */
  externalId: string;
  /** Funnel-record dates (#2554); null when the cell is blank. */
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  customerSince: Date | null;
}

export const IMPORT_LOCALES: readonly string[] = ['en', 'tr', 'de'];

// ── Pure field readers ───────────────────────────────────────────────────────

/**
 * The VAT match key: upper case with spaces, dots, slashes and hyphens removed,
 * so `DE 123.456.789`, `de123456789` and `DE-123-456-789` are one merchant.
 * A too-short value is not an identity and keys to '' (never matches).
 */
export function normalizeVatKey(raw: string | null | undefined): string {
  if (!raw) return '';
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return key.length >= 4 ? key : '';
}

/** ISO-3166-1 alpha-2, upper case. Anything else keys to '' and is rejected. */
export function normalizeCountry(raw: string | null | undefined): string {
  const key = (raw ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(key) ? key : '';
}

/**
 * The fallback match key. Both halves normalized, joined by a character neither
 * can contain, so "Acme" in DE and "Acme" in TR are two accounts and an account
 * with no country only ever matches another with no country.
 */
export function accountNameKey(name: string, country: string): string {
  return `${normalizeNameKey(name)} ${normalizeCountry(country)}`;
}

/**
 * The external-id match key (#2554): trimmed and lower-cased. Lower-cased
 * because the column is compared by MySQL's case-insensitive collation when the
 * usage feed looks it up — two spellings the database calls equal must not be
 * two accounts here. The value is stored as the file wrote it.
 */
export function normalizeExternalIdKey(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

/** The identity a row claims: its external id, else its VAT key, else its name+country key. */
export function accountMatchKey(row: { name: string; country: string; vatId: string; externalId?: string }): string {
  const external = normalizeExternalIdKey(row.externalId);
  if (external) return `ext:${external}`;
  const vat = normalizeVatKey(row.vatId);
  return vat ? `vat:${vat}` : `name:${accountNameKey(row.name, row.country)}`;
}

/**
 * The years a date cell may name (#2554 review). The trial dates keep the
 * hand-set trial end's bound (`parseTrialEndDate`: 2000–2100), because they
 * feed the reminder ladder; `customer_since` reaches back to 1900 — a merchant
 * can have been a customer since 1998, and refusing a well-formed ISO date as
 * "not an ISO date" would be a lie. The row error names the range.
 */
export const IMPORT_DATE_YEARS = {
  trial: { min: 2000, max: 2100 },
  customerSince: { min: 1900, max: 2100 },
} as const;

export interface ImportDateYears {
  min: number;
  max: number;
}

/** `YYYY-MM-DD` as midnight UTC, a real calendar day within `years`, else null. */
function parseIsoDay(text: string, years: ImportDateYears): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < years.min || year > years.max) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    return null;
  }
  return value;
}

/**
 * A date cell (#2554). Two ISO 8601 shapes and nothing else:
 *
 *   • `YYYY-MM-DD` — a calendar DAY, stored as midnight UTC, the same reading
 *     the hand-set trial end uses (`parseTrialEndDate`), so an imported
 *     `trial_ends_at` and a typed one fall on the same UTC day the reminder
 *     ladder compares by;
 *   • `YYYY-MM-DDTHH:MM[:SS[.sss]]` WITH a zone (`Z` or `±HH:MM`) — what a
 *     system export writes.
 *
 * A time without a zone is refused: its meaning would be the importing
 * machine's timezone. So is `04.05.2026`: day-first or month-first cannot be
 * told apart from the cell, and a wrong guess moves a trial end by months
 * without a single ERROR. Returns null for anything else — including an
 * impossible date (`2026-02-30` is refused, not rolled into March) and a year
 * outside `years` (default: the trial range, 2000–2100).
 */
export function parseImportDate(raw: string, years: ImportDateYears = IMPORT_DATE_YEARS.trial): Date | null {
  const text = raw.trim();
  const dayOnly = parseIsoDay(text, years);
  if (dayOnly) return dayOnly;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!m || !parseIsoDay(m[1], years)) return null;
  const [hours, minutes, seconds] = [Number(m[2]), Number(m[3]), Number(m[4] ?? '0')];
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const value = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}${m[5] ?? ''}${m[6]}`);
  return Number.isNaN(value.getTime()) ? null : value;
}

// ── The lead person's address (#2407) ────────────────────────────────────────
//
// WHY THE LEAD USER DOES NOT CARRY THE MERCHANT'S REAL MAILBOX.
//   `MentorshipRelation.menteeId` is a required FK, so a funnel record needs a
//   `User` row and the import mints one. `src/lib/menteeAccount.ts` explains why
//   such a record is nevertheless not an account — but it names the precondition
//   out loud: "every recovery path is a dead end … that mail goes to the
//   stand-in address". A sentinel password alone is NOT that dead end.
//   `POST /api/auth/forgot` mails a reset link to any existing user and
//   `POST /api/auth/reset` consumes it, neither of them asking
//   `isPendingActivation()`. Minting one lead per row on the merchant's real
//   mailbox would therefore hand every imported contact — people who never
//   asked for a portal login — a password they can set themselves.
//
//   So the lead's `email` is a generated stand-in on the domain that exists for
//   exactly this (`import.local`, `PLACEHOLDER_EMAIL_DOMAIN`), the same shape
//   `scripts/import-csv.mjs` already writes. The merchant's real address is not
//   lost: it is written to `Company.contactEmail`, which is where #2407 asks
//   for it, and a mentor who decides this person should have a login corrects
//   the address through `PATCH /api/mentor/mentees/[id]` — the documented path
//   for precisely these rows.
//
//   The stand-in is DERIVED, not random: the same contact in the same
//   organization always produces the same address, which is what makes the
//   second run of a file find its lead again instead of minting a twin. The org
//   is part of the input because `User.email` is globally unique — two tenants
//   importing the same contact must not collide on one row.

/** FNV-1a, 32-bit. Dependency-free and deterministic; a disambiguator, not a MAC. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The address the lead `User` is CREATED with. `orgKey` is the run's `orgId`
 * (`''` for the single-tenant install).
 */
export function leadStandInEmail(contactEmailKey: string, orgKey: string): string {
  const slug = contactEmailKey
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 96);
  return `${slug || 'lead'}.${fnv1a32(`${orgKey}|${contactEmailKey}`)}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

/**
 * How a stored lead is indexed. A real address is indexed by its normalized
 * key; a stand-in — which `normalizeEmailKey` blanks on purpose — by the
 * literal address, so a lead this importer created is found again. An erased
 * account is indexed by neither: matching one would resurrect it.
 */
export function leadIndexKey(email: string): string {
  const normalized = normalizeEmailKey(email);
  if (normalized) return normalized;
  const literal = email.trim().toLowerCase();
  return isPlaceholderEmail(literal) ? literal : '';
}

/**
 * Money as integer minor units (CLAUDE.md: never a float). Accepts `1.234,50`
 * and `1,234.50` — the same file carries both when Excel has seen two locales —
 * by treating the LAST separator as the decimal point.
 */
export function parseMinorUnits(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const cleaned = text.replace(/[^\d.,-]/g, '');
  if (!/^-?[\d.,]+$/.test(cleaned) || !/\d/.test(cleaned)) return NaN;
  const lastSep = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
  const tail = lastSep >= 0 ? cleaned.slice(lastSep + 1) : '';
  // A trailing group of exactly 1-2 digits is a decimal fraction; 3 is a
  // thousands group ("1.234" is one thousand two hundred thirty-four euro).
  const hasFraction = lastSep >= 0 && tail.length > 0 && tail.length <= 2;
  const whole = (hasFraction ? cleaned.slice(0, lastSep) : cleaned).replace(/[.,]/g, '');
  const fraction = hasFraction ? tail.padEnd(2, '0') : '00';
  const value = Number(`${whole}${fraction}`);
  return Number.isSafeInteger(value) ? value : NaN;
}

/** `;`-separated, trimmed, de-duplicated, order preserved. */
export function parseChannels(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(';')) {
    const value = part.trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out;
}

// Shape only. The address is never mailed by the importer, so this rejects the
// obviously-not-an-address rather than attempting RFC 5322.
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);
}

// ── validate ─────────────────────────────────────────────────────────────────

export interface MarketingValidateContext {
  /**
   * The stage keys of the org's OWN pipeline (`resolvePipelineStages`). Never a
   * hardcoded list: `npm run check:stage-keys` exists because a literal key
   * type-checks, passes on the default seed and breaks for the one tenant that
   * renamed its stages.
   */
  stageKeys: readonly string[];
}

type ColumnReader = (field: string) => string;

function columnReader(header: string[], values: string[]): ColumnReader {
  const index = new Map<string, number>();
  for (const spec of MARKETING_IMPORT_COLUMNS) {
    let at = headerIndex(header, spec.header);
    for (const alias of spec.aliases) {
      if (at >= 0) break;
      at = headerIndex(header, alias);
    }
    index.set(spec.field, at);
  }
  return (field) => {
    const at = index.get(field) ?? -1;
    return at >= 0 ? (values[at] ?? '').trim() : '';
  };
}

/**
 * One callback for the whole marketing column set. Pure and synchronous, as the
 * engine requires: everything that needs the database (the owner, the existing
 * accounts) is decided in `resolve`.
 *
 * A row is only ever rejected for something that makes it unwritable — a
 * missing name, a value longer than the column, a stage the org does not have.
 * Everything softer is a warning on a row that still lands.
 */
export function makeMarketingValidator(context: MarketingValidateContext) {
  const stageKeys = new Set(context.stageKeys);
  return function validateMarketingRow(
    parsed: ParsedRow,
    header: string[],
  ): ValidatedRow<MarketingAccountRow> {
    const read = columnReader(header, parsed.values);
    const name = read('name');
    const reject = (reason: string): ValidatedRow<MarketingAccountRow> => ({
      ok: false,
      row: parsed.row,
      key: name || `row ${parsed.row}`,
      status: 'ERROR',
      reason,
    });

    if (!name) return reject('name is required');

    const rawCountry = read('country');
    const country = normalizeCountry(rawCountry);
    if (rawCountry && !country) return reject(`country must be an ISO-3166-1 alpha-2 code, got "${rawCountry}"`);

    const rawVat = read('vatId');
    const vatId = normalizeVatKey(rawVat);
    if (rawVat && !vatId) return reject(`vat_id is too short to be an identity: "${rawVat}"`);

    const rawLocale = read('locale').toLowerCase();
    if (rawLocale && !IMPORT_LOCALES.includes(rawLocale)) {
      return reject(`locale must be one of ${IMPORT_LOCALES.join('/')}, got "${rawLocale}"`);
    }

    const stage = read('stage');
    if (stage && !stageKeys.has(stage)) {
      return reject(
        `stage "${stage}" is not one of this organization's pipeline stages (${[...stageKeys].join(', ')})`,
      );
    }

    const rawTransactions = read('monthlyTransactions');
    let monthlyTransactions: number | null = null;
    if (rawTransactions) {
      const digits = rawTransactions.replace(/[\s.,]/g, '');
      if (!/^\d+$/.test(digits)) return reject(`monthly_transactions must be a whole number, got "${rawTransactions}"`);
      monthlyTransactions = Number(digits);
    }

    const rawMrr = read('mrr');
    const mrrMinor = rawMrr ? parseMinorUnits(rawMrr) : null;
    if (mrrMinor !== null && !Number.isSafeInteger(mrrMinor)) return reject(`mrr is not a number: "${rawMrr}"`);
    if (mrrMinor !== null && mrrMinor < 0) return reject(`mrr must not be negative: "${rawMrr}"`);

    const rawContactEmail = read('contactEmail');
    const contactEmail = rawContactEmail.toLowerCase();
    if (contactEmail && !looksLikeEmail(contactEmail)) return reject(`contact_email is not an address: "${rawContactEmail}"`);
    // `normalizeEmailKey` blanks the generated stand-in domains. An address on
    // one of them is not a mailbox and must never become a person's identity.
    if (contactEmail && !normalizeEmailKey(contactEmail)) {
      return reject(`contact_email is on a reserved stand-in domain: "${rawContactEmail}"`);
    }

    const rawOwner = read('ownerEmail');
    const ownerEmail = rawOwner.toLowerCase();
    if (ownerEmail && !looksLikeEmail(ownerEmail)) return reject(`owner_email is not an address: "${rawOwner}"`);

    const dates: Record<'trialStartedAt' | 'trialEndsAt' | 'customerSince', Date | null> = {
      trialStartedAt: null,
      trialEndsAt: null,
      customerSince: null,
    };
    for (const [field, header, years] of [
      ['trialStartedAt', 'trial_started_at', IMPORT_DATE_YEARS.trial],
      ['trialEndsAt', 'trial_ends_at', IMPORT_DATE_YEARS.trial],
      ['customerSince', 'customer_since', IMPORT_DATE_YEARS.customerSince],
    ] as const) {
      const raw = read(field);
      if (!raw) continue;
      const value = parseImportDate(raw, years);
      if (!value) {
        return reject(
          `${header} must be an ISO date (YYYY-MM-DD, or a date-time with a zone) between ${years.min}-01-01 and ${years.max}-12-31, got "${raw}"`,
        );
      }
      dates[field] = value;
    }
    if (dates.trialStartedAt && dates.trialEndsAt && dates.trialEndsAt < dates.trialStartedAt) {
      return reject('trial_ends_at is before trial_started_at');
    }

    const row: MarketingAccountRow = {
      name,
      legalName: read('legalName'),
      country,
      city: read('city'),
      vatId,
      website: read('website'),
      industry: read('industry'),
      locale: rawLocale,
      stage,
      source: read('source'),
      monthlyTransactions,
      mrrMinor,
      ownerEmail,
      channels: parseChannels(read('channels')),
      contactName: read('contactName'),
      contactEmail,
      contactPhone: read('contactPhone'),
      externalId: read('externalId'),
      ...dates,
    };

    // Length is checked last and over every stored string at once: truncating
    // an operator's migration silently is worse than refusing the row.
    for (const [field, value] of Object.entries(row)) {
      if (typeof value !== 'string') continue;
      const limit = FIELD_LIMITS[field] ?? MAX_FIELD_LENGTH;
      if (value.length > limit) return reject(`${field} is longer than ${limit} characters`);
    }

    return { ok: true, row: parsed.row, key: accountMatchKey(row), value: row };
  };
}

// ── One row typed in by hand (#2562) ─────────────────────────────────────────

/** What the "new lead / account" form sends — field names of the column contract. */
export type ManualAccountFields = Partial<
  Pick<
    MarketingAccountRow,
    | 'name'
    | 'country'
    | 'vatId'
    | 'contactName'
    | 'contactEmail'
    | 'contactPhone'
    | 'source'
    | 'stage'
    | 'city'
    | 'industry'
  >
>;

/**
 * ONE row of the import contract built from the form's fields, as a parsed
 * table under the canonical headers — so a hand-typed lead goes through the
 * very validator a file does (VAT/country normalization, the per-column length
 * limits, the org's own stage keys) instead of a second, drifting copy of those
 * rules. A field the form did not send is not a column at all.
 */
export function manualAccountTable(fields: ManualAccountFields): ParsedTable {
  const header: string[] = [];
  const values: string[] = [];
  for (const spec of MARKETING_IMPORT_COLUMNS) {
    const value = (fields as Record<string, unknown>)[spec.field];
    if (typeof value !== 'string') continue;
    header.push(spec.header);
    values.push(value.trim());
  }
  return { header, rows: [{ row: 1, values }], delimiter: ',' };
}

// ── The target snapshot ──────────────────────────────────────────────────────

export interface MarketingAccountTarget {
  id: string;
  name: string;
  vatId: string | null;
  country: string | null;
  industry: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Optional only so a snapshot built before #2554 still reads; the store selects it. */
  externalId?: string | null;
}

export interface MarketingLeadTarget {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  city: string | null;
  country: string | null;
  preferredLanguage: string | null;
  referralSource: string | null;
  companyId: string | null;
  /**
   * The person's referrer today — a `Source` or a referring person (#2570).
   * Attribution is FIRST TOUCH, so a lead with either keeps it and the row
   * plans no `sourceName`. Optional so an older snapshot still reads; the
   * store always selects both.
   */
  sourceId?: string | null;
  referredById?: string | null;
  /**
   * The person's role. Only a MENTEE is a lead: an ADMIN, MENTOR or COMPANY
   * user whose address is typed in as a contact is staff, and treating them as
   * the lead would fill in their profile, move their `companyId` and put them
   * on the board as somebody's mentee (#2562 review). Optional only so that a
   * snapshot built before the field existed still reads; the store always
   * selects it.
   */
  role?: string | null;
}

/** Whether a User found by a contact address may stand in as that contact's lead. */
export function isLeadRole(role: string | null | undefined): boolean {
  return role === undefined || role === 'MENTEE';
}

export interface MarketingRelationTarget {
  id: string;
  mentorId: string;
  menteeId: string;
  companyId: string | null;
  pipelineStatus: string;
  /** Only ACTIVE relations are the funnel record; a COMPLETED one is history. */
  status: string;
  /** The record's dates (#2554). Optional so an older snapshot still reads. */
  trialStartedAt?: Date | null;
  trialEndsAt?: Date | null;
  startDate?: Date | null;
}

export interface MarketingTargetSnapshot {
  accounts: MarketingAccountTarget[];
  leads: MarketingLeadTarget[];
  /** Every relation of the leads above — enough to answer "does one exist?". */
  relations: MarketingRelationTarget[];
}

// ── The plan ─────────────────────────────────────────────────────────────────

export interface MarketingAccountWrite {
  name?: string;
  vatId?: string;
  country?: string;
  industry?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  externalId?: string;
}

/** The funnel record's dates a row writes (#2554). */
export interface MarketingRelationWrite {
  trialStartedAt?: Date;
  trialEndsAt?: Date;
  /** `customer_since`. */
  startDate?: Date;
}

export interface MarketingLeadWrite {
  fullName?: string;
  phone?: string;
  city?: string;
  country?: string;
  preferredLanguage?: string;
  referralSource?: string;
}

export interface MarketingFunnelPlan {
  /** The user who owns this funnel record — `mentorId`. */
  ownerId: string;
  ownerEmail: string;
  /** The merchant contact's own address, normalized. The row's lead identity. */
  emailKey: string;
  /**
   * The `email` a CREATED lead User carries — a generated stand-in, never the
   * merchant's mailbox (see "The lead person's address" above). Ignored when
   * `leadId` is set: an existing person keeps the address they already have.
   */
  leadEmail: string;
  /** Existing lead User, or null when the row creates one. */
  leadId: string | null;
  leadChanges: MarketingLeadWrite;
  leadChanged: string[];
  /**
   * The tenant `Source` name this row binds its lead to, or null (#2570).
   * Decided HERE from the incoming value — never from `leadChanges`, which is
   * a diff and omits a `referralSource` the lead already carries (or one the
   * run was not allowed to overwrite), so re-importing a book whose leads
   * predate attribution would bind none of them. Null when the lead already
   * has a referrer of either kind (first touch), so the writer never creates
   * a Source it will not use.
   */
  sourceName: string | null;
  /** Existing ACTIVE relation with this owner, or null when one is created. */
  relationId: string | null;
  /** The relation's stage today; null when the relation is being created. */
  fromStage: string | null;
  toStage: string;
  /**
   * The dates the file gives the funnel record (#2554). For a record being
   * created, every date the row carries; for an existing one, what
   * `planFieldUpdates` lets through — gaps only, unless authoritative.
   */
  relationChanges: MarketingRelationWrite;
  relationChanged: string[];
  /** Dates the file disagreed with and was not allowed to overwrite. */
  relationWithheld: string[];
  /**
   * For a record placed in TRIAL_ACTIVE, where its trial end comes from after
   * this row (#2554/#2555): this row writes the file's (`file`), the record
   * already has one — including the same date the file repeats — (`kept`),
   * the #2551 default window stamps it (`default`), or nobody gives one
   * (`missing` — a trial no reminder will fire for). Null for any other stage.
   */
  trialEnd: 'file' | 'kept' | 'default' | 'missing' | null;
  /** True when anything above has to be written. */
  pending: boolean;
}

export interface MarketingPlanValue {
  input: MarketingAccountRow;
  account: {
    targetId: string | null;
    changes: MarketingAccountWrite;
    changed: string[];
    /** Fields the file disagreed with and was not allowed to overwrite. */
    withheld: string[];
  };
  funnel: MarketingFunnelPlan | null;
  /** Non-fatal notes on a row that still lands. */
  warnings: string[];
  /**
   * Set when the DIFF refuses the row (#2554: a conflicting external id). The
   * engine's plan vocabulary has no ERROR — a row that failed validation never
   * reaches a plan — so such a row is planned as a SKIP carrying this reason,
   * and `applyPlannedAccounts` reports it as the ERROR it is, in a dry run and
   * an apply alike. Never written.
   */
  refused?: string;
}

export type MarketingPlannedRow = PlannedRow<MarketingPlanValue>;

export interface MarketingDiffContext {
  /** The `--owner` user: the run's default funnel owner. */
  defaultOwnerId: string;
  defaultOwnerEmail: string;
  /** Lower-cased address → user id, for rows that name their own owner. */
  ownerIdByEmail: ReadonlyMap<string, string>;
  /** The run's organization id, `''` for the single-tenant install. Part of the
   * lead stand-in address, because `User.email` is globally unique. */
  orgKey: string;
  /**
   * When true the file overwrites a value it disagrees with; when false (the
   * default) it only fills gaps. One policy for every external writer —
   * `planFieldUpdates`, shared with SSO sync and the roster feed.
   */
  authoritative: boolean;
  /**
   * The org's `trialLengthDays` (#2551), for the dry-run warning on a
   * TRIAL_ACTIVE row without `trial_ends_at`. The write resolves it again;
   * this is only what the warning says. Defaults to the code default.
   */
  trialLengthDays?: number;
  /**
   * "Today" for the dry-run warning on a trial whose end has already passed.
   * Defaults to the wall clock; the unit tests pin it.
   */
  now?: Date;
  /**
   * Which `Source` a lead is attributed to (#2570). Omitted: the file's own
   * `source` column, typed by a person (`typedSourceName()`). A string or null:
   * the caller already decided from machine inputs (`leadSourceName()` — the
   * demo form's UTM parameters), null being "unknown", i.e. no Source.
   */
  leadSourceName?: string | null;
}

function blankToUndefined(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

/**
 * Two spellings of one number (#2407). `+90 555 123 45 67`, `0555 123 45 67`
 * and `555-123-4567` are the same phone, and `planFieldUpdates` compares
 * strings — without this the file would "disagree" with its own last run, which
 * is either a withheld field reported every run or, with `--authoritative`, a
 * pointless rewrite that makes the second run of the same file an UPDATE.
 */
function samePhone(current: string, incoming: string | undefined): boolean {
  if (!incoming) return true;
  const a = normalizePhoneKey(current);
  const b = normalizePhoneKey(incoming);
  return a !== '' && a === b;
}

/** Drop a phone field whose only difference is formatting. */
function withoutRestatedPhone<T extends { phone?: string } | { contactPhone?: string }>(
  incoming: T,
  field: keyof T & string,
  current: string,
): T {
  const value = incoming[field] as string | undefined;
  if (!samePhone(current, value)) return incoming;
  const copy = { ...incoming };
  delete copy[field];
  return copy;
}

// ── Matching a row to an account ─────────────────────────────────────────────
//
// THE COUNTRY MAY BE MISSING ON ONE SIDE.
//   `Company.country` and `Company.vatId` are introduced by this very change,
//   so on the day the importer first runs EVERY account the tenant already
//   holds has both NULL. The strong key cannot match anything, and an exact
//   name+country key would read the stored `"acme gmbh␀"` and the file's
//   `"acme gmbh␀DE"` as two merchants — duplicating the whole account master on
//   the one run that matters, silently, because `absent` is empty and the run
//   after it matches the fresh twin and reports UNCHANGED.
//
//   So a blank country on EITHER side falls back to the name alone, and only
//   when that name belongs to exactly one account: two "Acme GmbH" rows in DE
//   and TR are still two merchants, and a countryless row naming them is
//   genuinely ambiguous — reported as such, never guessed. A loosely matched
//   account has its country filled in as a gap, so the next run keys exactly.

interface AccountLike {
  name: string;
  vatId: string | null;
  country: string | null;
  externalId?: string | null;
}

interface AccountIndex<T extends AccountLike> {
  /**
   * Every account under its external id. A LIST, because `Company.externalId`
   * is deliberately not unique (see its schema comment): two accounts of one
   * org carrying the same id is a state this importer reports, never resolves.
   */
  byExternal: Map<string, T[]>;
  byVat: Map<string, T>;
  byNameCountry: Map<string, T>;
  /** Every account under its name alone — the loose half of the key. */
  byName: Map<string, T[]>;
}

function emptyAccountIndex<T extends AccountLike>(): AccountIndex<T> {
  return { byExternal: new Map(), byVat: new Map(), byNameCountry: new Map(), byName: new Map() };
}

function indexAccount<T extends AccountLike>(index: AccountIndex<T>, account: T): void {
  const external = normalizeExternalIdKey(account.externalId);
  if (external) {
    const list = index.byExternal.get(external);
    if (list) list.push(account);
    else index.byExternal.set(external, [account]);
  }
  const vat = normalizeVatKey(account.vatId);
  if (vat && !index.byVat.has(vat)) index.byVat.set(vat, account);
  const nameCountry = accountNameKey(account.name, account.country ?? '');
  if (!index.byNameCountry.has(nameCountry)) index.byNameCountry.set(nameCountry, account);
  const nameOnly = normalizeNameKey(account.name);
  const bucket = index.byName.get(nameOnly);
  if (bucket) bucket.push(account);
  else index.byName.set(nameOnly, [account]);
}

type AccountMatch<T> =
  | { kind: 'none' }
  | { kind: 'one'; target: T }
  | { kind: 'ambiguous'; count: number }
  /** The row's external id contradicts what the other keys found (#2554). */
  | { kind: 'conflict'; reason: string };

/**
 * External id first, then VAT id, then name+country (#2554, #2405).
 *
 * The external id is the product's own identity for the merchant, so it can
 * only CONFIRM what the weaker keys say — never be overruled by them, and never
 * be guessed around. Every disagreement is a `conflict` the caller reports as
 * an ERROR on the row:
 *
 *   • two accounts of the org already carry the id;
 *   • the id names account A while the VAT id names account B;
 *   • the weaker keys find an account that carries a DIFFERENT external id.
 *
 * An id nobody carries yet falls through to the weaker keys, and the account
 * they find (with no external id of its own) has it filled in as a gap.
 */
function matchAccount<T extends AccountLike>(
  index: AccountIndex<T>,
  value: { name: string; country: string; vatId: string; externalId?: string },
): AccountMatch<T> {
  const external = normalizeExternalIdKey(value.externalId);
  const byExternal = external ? (index.byExternal.get(external) ?? []) : [];
  if (byExternal.length > 1) {
    return {
      kind: 'conflict',
      reason: `external_id "${value.externalId}" is carried by ${byExternal.length} accounts of this organization — merge them in the app first`,
    };
  }
  if (byExternal.length === 1) {
    const target = byExternal[0];
    const vat = normalizeVatKey(value.vatId);
    const byVat = vat ? index.byVat.get(vat) : undefined;
    if (byVat && byVat !== target) {
      return { kind: 'conflict', reason: `external_id "${value.externalId}" and vat_id name two different accounts` };
    }
    return { kind: 'one', target };
  }

  const found = matchWithoutExternal(index, value);
  if (found.kind === 'one' && external) {
    const theirs = normalizeExternalIdKey(found.target.externalId);
    if (theirs && theirs !== external) {
      return {
        kind: 'conflict',
        reason: `external_id "${value.externalId}" differs from the external id "${found.target.externalId}" of the account this row matches`,
      };
    }
  }
  return found;
}

/** VAT id, then name+country, then the loose name half described above. */
function matchWithoutExternal<T extends AccountLike>(
  index: AccountIndex<T>,
  value: { name: string; country: string; vatId: string },
): AccountMatch<T> {
  const vat = normalizeVatKey(value.vatId);
  const byVat = vat ? index.byVat.get(vat) : undefined;
  if (byVat) return { kind: 'one', target: byVat };

  const exact = index.byNameCountry.get(accountNameKey(value.name, value.country));
  if (exact) return { kind: 'one', target: exact };

  // Only the pairs where one side says nothing about the country: when both
  // name a country and the two differ, they are two merchants.
  const candidates = index.byName.get(normalizeNameKey(value.name)) ?? [];
  const loose = candidates.filter((c) => !value.country || !normalizeCountry(c.country ?? ''));
  if (loose.length === 1) return { kind: 'one', target: loose[0] };
  if (loose.length > 1) return { kind: 'ambiguous', count: loose.length };
  return { kind: 'none' };
}

/**
 * Decide, for every valid row, what it is. Pure — this is the function the
 * whole task is really about, so it is the one with the assertions behind it.
 *
 * `absent` is deliberately EMPTY. The roster feed's `absent` means "the HR
 * system no longer lists this person", which is a fact only a FULL export can
 * state; an account spreadsheet is a partial list, and reporting every
 * unmentioned company as absent would invite exactly the deprovisioning this
 * importer must never imply.
 */
export function diffMarketingAccounts(
  rows: { row: number; key: string; value: MarketingAccountRow }[],
  snapshot: MarketingTargetSnapshot,
  context: MarketingDiffContext,
): ResolveResult<MarketingPlanValue> {
  const index = emptyAccountIndex<MarketingAccountTarget>();
  for (const account of snapshot.accounts) indexAccount(index, account);

  const leadByEmail = new Map<string, MarketingLeadTarget>();
  for (const lead of snapshot.leads) {
    // Staff is never a lead — see `MarketingLeadTarget.role`. Such a contact
    // gets a fresh stand-in lead record, exactly like an unknown address.
    if (!isLeadRole(lead.role)) continue;
    const key = leadIndexKey(lead.email);
    if (key && !leadByEmail.has(key)) leadByEmail.set(key, lead);
  }

  const plan: MarketingPlannedRow[] = [];
  // Accounts this run has already planned to CREATE, under the same index, so a
  // later row naming the same merchant resolves onto the first row's plan
  // rather than racing it into a twin. They carry a row number instead of an
  // id: there is no id yet, and a plan is not a row.
  const planned = emptyAccountIndex<AccountLike & { row: number }>();
  // Existing accounts an earlier row already claimed — two rows updating one
  // account is the same duplicate, one step later.
  const claimedBy = new Map<string, number>();
  // The external id the claiming row gave each existing account (#2554 review).
  // The cutover case is every row matching an account whose `externalId` is
  // still null, so the id is not in `index` yet — without this a second row
  // naming the same account under a DIFFERENT id would read as a harmless
  // duplicate and the first id would win in silence.
  const claimedExternal = new Map<string, { row: number; key: string }>();
  const seenLeadKeys = new Map<string, number>();
  // External ids the file has already given to an account (#2554). One id, one
  // account: a later row handing the same id to a DIFFERENT account would leave
  // two accounts the usage feed cannot tell apart.
  const seenExternal = new Map<string, number>();

  const skip = (row: number, key: string, value: MarketingAccountRow, reason: string) => {
    plan.push({
      row,
      key,
      status: 'SKIP',
      reason,
      value: { input: value, account: { targetId: null, changes: {}, changed: [], withheld: [] }, funnel: null, warnings: [] },
    });
  };
  // A refusal the diff makes (see `MarketingPlanValue.refused`): planned as a
  // SKIP carrying the reason, reported as an ERROR by `applyPlannedAccounts`.
  const refuse = (row: number, key: string, value: MarketingAccountRow, reason: string) => {
    plan.push({
      row,
      key,
      status: 'SKIP',
      reason,
      value: {
        input: value,
        account: { targetId: null, changes: {}, changed: [], withheld: [] },
        funnel: null,
        warnings: [],
        refused: reason,
      },
    });
  };

  for (const { row, key, value } of rows) {
    const externalKey = normalizeExternalIdKey(value.externalId);
    // Two rows for the same account in one file: the first wins and the second
    // is reported. Without this the second row races the `@@unique([orgId,
    // vatId])` index and takes its whole chunk down with it. The check is on
    // the account a row RESOLVES to, never on the identity it claims: one file
    // listing a merchant twice — the VAT filled in on one line only — holds two
    // different claimed keys and is still one account.
    const inFile = matchAccount(planned, value);
    if (inFile.kind === 'conflict') {
      refuse(row, key, value, `${inFile.reason} (conflicts with an earlier row of this file)`);
      continue;
    }
    if (inFile.kind === 'one') {
      // One external id on two lines that name two different VAT ids is not
      // "the same merchant twice" — the file contradicts itself about who the id
      // belongs to, and which line is right is not ours to pick.
      const earlierVat = normalizeVatKey(inFile.target.vatId);
      const thisVat = normalizeVatKey(value.vatId);
      if (
        externalKey &&
        normalizeExternalIdKey(inFile.target.externalId) === externalKey &&
        earlierVat &&
        thisVat &&
        earlierVat !== thisVat
      ) {
        refuse(row, key, value, `external_id "${value.externalId}" is given to row ${inFile.target.row} with a different vat_id`);
        continue;
      }
      skip(row, key, value, `duplicate account in file (first seen at row ${inFile.target.row})`);
      continue;
    }
    if (inFile.kind === 'ambiguous') {
      skip(row, key, value, `duplicate account in file (matches ${inFile.count} earlier rows by name; add a country or vat_id)`);
      continue;
    }

    const found = matchAccount(index, value);
    if (found.kind === 'conflict') {
      refuse(row, key, value, found.reason);
      continue;
    }
    if (found.kind === 'ambiguous') {
      skip(
        row,
        key,
        value,
        `ambiguous: ${found.count} existing accounts are named "${value.name}" — add a country or vat_id column`,
      );
      continue;
    }
    const target = found.kind === 'one' ? found.target : undefined;
    if (target) {
      const claimed = claimedBy.get(target.id);
      if (claimed !== undefined) {
        const earlierExternal = claimedExternal.get(target.id);
        if (externalKey && earlierExternal && earlierExternal.key !== externalKey) {
          refuse(
            row,
            key,
            value,
            `external_id "${value.externalId}" differs from the external_id row ${earlierExternal.row} gives the same account`,
          );
          continue;
        }
        skip(row, key, value, `duplicate account in file (first seen at row ${claimed})`);
        continue;
      }
    }
    if (externalKey) {
      const earlier = seenExternal.get(externalKey);
      if (earlier !== undefined) {
        refuse(row, key, value, `external_id "${value.externalId}" is already given to a different account by row ${earlier}`);
        continue;
      }
      seenExternal.set(externalKey, row);
    }
    if (target) {
      claimedBy.set(target.id, row);
      if (externalKey) claimedExternal.set(target.id, { row, key: externalKey });
    } else {
      indexAccount(planned, {
        row,
        name: value.name,
        vatId: value.vatId || null,
        country: value.country || null,
        externalId: value.externalId || null,
      });
    }

    const incoming: MarketingAccountWrite = {
      name: value.name,
      vatId: blankToUndefined(value.vatId),
      country: blankToUndefined(value.country),
      industry: blankToUndefined(value.industry),
      contactName: blankToUndefined(value.contactName),
      contactEmail: blankToUndefined(value.contactEmail),
      contactPhone: blankToUndefined(value.contactPhone),
      // An id the account already carries under another spelling of the same
      // key is not a change (matchAccount refused every real disagreement).
      externalId:
        target && normalizeExternalIdKey(target.externalId) === externalKey
          ? undefined
          : blankToUndefined(value.externalId),
    };

    const warnings: string[] = [];
    let accountChanges: MarketingAccountWrite;
    let accountChanged: string[];
    let withheld: string[] = [];
    if (target) {
      const current = {
        name: target.name,
        vatId: target.vatId ?? '',
        country: target.country ?? '',
        industry: target.industry ?? '',
        contactName: target.contactName ?? '',
        contactEmail: target.contactEmail ?? '',
        contactPhone: target.contactPhone ?? '',
        externalId: target.externalId ?? '',
      };
      const planned = planFieldUpdates(
        current,
        withoutRestatedPhone(incoming, 'contactPhone', current.contactPhone),
        { authoritative: context.authoritative },
      );
      accountChanges = planned.changes;
      accountChanged = planned.changed;
      withheld = planned.withheld;
    } else {
      accountChanges = incoming;
      accountChanged = Object.keys(incoming).filter((f) => incoming[f as keyof MarketingAccountWrite] !== undefined);
    }

    const funnel = planFunnel(value, target, {
      leadByEmail,
      relations: snapshot.relations,
      seenLeadKeys,
      row,
      warnings,
      context,
    });
    if (funnel && 'refused' in funnel) {
      refuse(row, key, value, funnel.refused);
      continue;
    }
    // The dates live on the funnel record, so a row that places none cannot
    // keep them — said out loud rather than dropped (#2554).
    if (!funnel) {
      const dated = (
        [
          ['trial_started_at', value.trialStartedAt],
          ['trial_ends_at', value.trialEndsAt],
          ['customer_since', value.customerSince],
        ] as const
      )
        .filter(([, date]) => date !== null)
        .map(([header]) => header);
      if (dated.length > 0) warnings.push(`${dated.join(', ')} not stored: the row places no funnel record`);
    }

    const status = target
      ? accountChanged.length > 0 || funnel?.pending
        ? 'UPDATE'
        : 'UNCHANGED'
      : 'CREATE';

    const leftAlone = [...withheld, ...(funnel?.relationWithheld ?? []).map((f) => `funnelRecord.${f}`)];
    const reason = [
      ...(leftAlone.length > 0 ? [`left alone: ${leftAlone.join(', ')}`] : []),
      ...warnings,
    ].join('; ');

    plan.push({
      row,
      key,
      status,
      targetId: target?.id ?? null,
      changed: [...accountChanged, ...(funnel?.pending ? funnelChangedFields(funnel) : [])],
      ...(reason ? { reason } : {}),
      value: {
        input: value,
        account: { targetId: target?.id ?? null, changes: accountChanges, changed: accountChanged, withheld },
        funnel,
        warnings,
      },
    });
  }

  return { plan, absent: [] };
}

function funnelChangedFields(funnel: MarketingFunnelPlan): string[] {
  const fields: string[] = [];
  if (!funnel.leadId) fields.push('lead');
  else {
    fields.push(...funnel.leadChanged.map((f) => `lead.${f}`));
    if (funnel.sourceName) fields.push('lead.source');
  }
  if (!funnel.relationId) fields.push('funnelRecord');
  else {
    if (funnel.fromStage !== funnel.toStage) fields.push('pipelineStatus');
    fields.push(...funnel.relationChanged.map((f) => `funnelRecord.${f}`));
  }
  return fields;
}

function planFunnel(
  value: MarketingAccountRow,
  target: MarketingAccountTarget | undefined,
  deps: {
    leadByEmail: Map<string, MarketingLeadTarget>;
    relations: MarketingRelationTarget[];
    seenLeadKeys: Map<string, number>;
    row: number;
    warnings: string[];
    context: MarketingDiffContext;
  },
): MarketingFunnelPlan | { refused: string } | null {
  const { context, warnings } = deps;
  if (!value.stage) return null;

  // The relation's `menteeId` is a required FK, so a funnel record needs a
  // person. A row with a stage and no contact keeps its Company and loses only
  // the stage — the account is the thing that must not be dropped.
  const emailKey = normalizeEmailKey(value.contactEmail);
  if (!emailKey) {
    warnings.push(`stage "${value.stage}" not placed: the row has no primary contact e-mail`);
    return null;
  }

  const ownerId = value.ownerEmail
    ? context.ownerIdByEmail.get(value.ownerEmail)
    : context.defaultOwnerId;
  if (!ownerId) {
    warnings.push(`stage "${value.stage}" not placed: owner_email "${value.ownerEmail}" is not a user of this organization`);
    return null;
  }
  const ownerEmail = value.ownerEmail || context.defaultOwnerEmail;

  const firstSeen = deps.seenLeadKeys.get(emailKey);
  if (firstSeen !== undefined) {
    warnings.push(`stage "${value.stage}" not placed: contact ${emailKey} is already the lead of row ${firstSeen}`);
    return null;
  }
  deps.seenLeadKeys.set(emailKey, deps.row);

  // An existing person is reused whichever address they carry: the real one
  // (someone applied, or a mentor typed them in) or the stand-in a previous run
  // of this importer created. Only a CREATE gets the stand-in.
  const leadEmail = leadStandInEmail(emailKey, context.orgKey);
  const lead = deps.leadByEmail.get(emailKey) ?? deps.leadByEmail.get(leadEmail);
  const incomingLead: MarketingLeadWrite = {
    fullName: blankToUndefined(value.contactName),
    phone: blankToUndefined(value.contactPhone),
    city: blankToUndefined(value.city),
    country: blankToUndefined(value.country),
    preferredLanguage: blankToUndefined(value.locale),
    referralSource: blankToUndefined(value.source),
  };

  let leadChanges: MarketingLeadWrite;
  let leadChanged: string[];
  if (lead) {
    const current = {
      fullName: lead.fullName,
      phone: lead.phone ?? '',
      city: lead.city ?? '',
      country: lead.country ?? '',
      preferredLanguage: lead.preferredLanguage ?? '',
      referralSource: lead.referralSource ?? '',
    };
    const planned = planFieldUpdates(
      current,
      withoutRestatedPhone(incomingLead, 'phone', current.phone),
      { authoritative: context.authoritative },
    );
    leadChanges = planned.changes;
    leadChanged = planned.changed;
  } else {
    // A contact with no name: the merchant's own address is the only name there
    // is — the real one, not the stand-in, because `fullName` is what a person
    // reads. Better a findable lead than a blank `fullName` on a required column.
    leadChanges = { ...incomingLead, fullName: value.contactName || emailKey };
    leadChanged = Object.keys(leadChanges).filter((f) => leadChanges[f as keyof MarketingLeadWrite] !== undefined);
  }

  // ONE mentee, at most one ACTIVE mentor (#419). The relation this row means
  // is the lead's ACTIVE one; if it belongs to somebody else, the store's
  // `findActiveMentorship` guard refuses the row rather than stealing it.
  const relation = lead
    ? deps.relations.find((r) => r.menteeId === lead.id && r.status === 'ACTIVE') ?? null
    : null;

  // First touch (#2570): only a lead with no referrer of either kind gets one.
  const attributable = !lead || (!lead.sourceId && !lead.referredById);
  const resolvedSourceName =
    context.leadSourceName !== undefined ? context.leadSourceName : typedSourceName(value.source);
  const sourceName = attributable ? resolvedSourceName : null;

  const toStage = value.stage;
  const fromStage = relation ? relation.pipelineStatus : null;
  const relationCompanyDiffers =
    relation !== null && target !== undefined && relation.companyId !== target.id;

  // The record's dates (#2554), under the one overwrite policy: a new record
  // takes every date the row carries; an existing one only fills gaps unless
  // the run is authoritative. `startDate` is never blank on a stored record
  // (it defaults to the insert), so `customer_since` corrects an existing
  // record only under `--authoritative` — and says so in the reason otherwise.
  const incomingRelation: MarketingRelationWrite = {
    ...(value.trialStartedAt ? { trialStartedAt: value.trialStartedAt } : {}),
    ...(value.trialEndsAt ? { trialEndsAt: value.trialEndsAt } : {}),
    ...(value.customerSince ? { startDate: value.customerSince } : {}),
  };
  let relationChanges: MarketingRelationWrite;
  let relationChanged: string[];
  let relationWithheld: string[] = [];
  if (relation) {
    const planned = planFieldUpdates(
      {
        trialStartedAt: relation.trialStartedAt ?? null,
        trialEndsAt: relation.trialEndsAt ?? null,
        startDate: relation.startDate ?? null,
      },
      incomingRelation,
      { authoritative: context.authoritative },
    );
    relationChanges = planned.changes as MarketingRelationWrite;
    relationChanged = planned.changed;
    relationWithheld = planned.withheld;
  } else {
    relationChanges = incomingRelation;
    relationChanged = Object.keys(incomingRelation);
  }

  // The pair the record will END UP with, not only the file's pair (#2554
  // review): a gap-fill that writes a start after the end the record already
  // carries would store a trial that ends before it began. Checked on what
  // the write would leave, so an authoritative run that replaces both is fine.
  const endAfter = relationChanges.trialEndsAt ?? relation?.trialEndsAt ?? null;
  const startAfter = relationChanges.trialStartedAt ?? relation?.trialStartedAt ?? null;
  if (endAfter && startAfter && endAfter < startAfter) {
    const fromFile = [
      ...(relationChanges.trialStartedAt ? [] : ['trial_started_at']),
      ...(relationChanges.trialEndsAt ? [] : ['trial_ends_at']),
    ];
    return {
      refused: `trial_ends_at would be before trial_started_at${
        fromFile.length > 0 ? ` (the record keeps its ${fromFile.join(' and ')}; fix the file or run with overwrite)` : ''
      }`,
    };
  }

  // The trial window the WRITE will stamp when the file gives no end (#2551's
  // `trialWindowFor`, applied by funnelRelationCreateData/UpdateData). The
  // dry run says so on the row, so an operator reads "30 days from the import
  // day" before it happens rather than in the reminder mails afterwards.
  let trialEnd: MarketingFunnelPlan['trialEnd'] = null;
  if (toStage === TRIAL_ACTIVE_STAGE_KEY) {
    const entering = relation === null || fromStage !== toStage;
    const days = context.trialLengthDays ?? DEFAULT_TRIAL_LENGTH_DAYS;
    trialEnd = relationChanges.trialEndsAt ? 'file' : relation?.trialEndsAt ? 'kept' : entering ? 'default' : 'missing';
    if (!endAfter && entering) {
      warnings.push(
        `trial_ends_at is blank: the default trial window applies (${days} days from ${startAfter ? 'trial_started_at' : 'the import day'})`,
      );
    } else if (!endAfter) {
      warnings.push('the record is in TRIAL_ACTIVE with no trial end and trial_ends_at is blank: no trial reminder will be sent until one is set');
    }
    // A trial that has already ended imports fine and is then moved to
    // TRIAL_EXPIRED by the next `expireTrials` sweep — said in the preview, so
    // the operator does not read it in the funnel the next morning.
    const today = context.now ?? new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const windowEnd =
      endAfter ?? (entering && startAfter ? new Date(startAfter.getTime() + days * 24 * 60 * 60 * 1000) : null);
    if (windowEnd && windowEnd.getTime() < todayUtc) {
      warnings.push(
        `${endAfter ? 'trial_ends_at' : 'the default trial window'} is in the past (${windowEnd
          .toISOString()
          .slice(0, 10)}): the record will move to TRIAL_EXPIRED on the next sweep`,
      );
    }
  }

  const pending =
    !lead ||
    leadChanged.length > 0 ||
    // An existing lead still to be attributed: re-importing a book whose leads
    // predate #2570 binds them even when nothing else about the row changed.
    sourceName !== null ||
    relation === null ||
    relationChanged.length > 0 ||
    fromStage !== toStage ||
    relationCompanyDiffers ||
    // A relation owned by someone else is a refusal, not a no-op: it must reach
    // the writer so the guard can report it as an ERROR on this row.
    relation.mentorId !== ownerId;

  return {
    ownerId,
    ownerEmail,
    emailKey,
    leadEmail,
    leadId: lead?.id ?? null,
    leadChanges,
    leadChanged,
    sourceName,
    relationId: relation?.id ?? null,
    fromStage,
    toStage,
    relationChanges,
    relationChanged,
    relationWithheld,
    trialEnd,
    pending,
  };
}

// ── The cutover numbers (#2555) ──────────────────────────────────────────────

/** Counts an operator reports after a run — no name, no address, no row. */
export interface MarketingImportMetrics {
  /** Rows that landed or would land: CREATE + UPDATE + UNCHANGED. */
  accounts: number;
  /** …of which matched an existing account (UPDATE + UNCHANGED). */
  matched: number;
  /** …of which carry an `external_id` in the file. */
  withExternalId: number;
  /** …of which place a funnel record in TRIAL_ACTIVE. */
  trials: number;
  /** Where those trials' end comes from — see `MarketingFunnelPlan.trialEnd`. */
  trialEnd: Record<'file' | 'kept' | 'default' | 'missing', number>;
}

/**
 * The PII-free numbers of one run (#2555 step 7: total, NEW, matched, ERROR,
 * external-id and trial-end fill rates), read off the engine's own report —
 * so the numbers an operator posts are the ones the run produced, not a
 * recount. A row that did not land (SKIP, ERROR) counts toward nothing here.
 */
export function marketingImportMetrics(
  rows: readonly { status: string; value?: MarketingPlanValue }[],
): MarketingImportMetrics {
  const metrics: MarketingImportMetrics = {
    accounts: 0,
    matched: 0,
    withExternalId: 0,
    trials: 0,
    trialEnd: { file: 0, kept: 0, default: 0, missing: 0 },
  };
  for (const row of rows) {
    if (!row.value || row.value.refused) continue;
    if (row.status !== 'CREATE' && row.status !== 'UPDATE' && row.status !== 'UNCHANGED') continue;
    metrics.accounts += 1;
    if (row.status !== 'CREATE') metrics.matched += 1;
    if (row.value.input.externalId) metrics.withExternalId += 1;
    const end = row.value.funnel?.trialEnd;
    if (end) {
      metrics.trials += 1;
      metrics.trialEnd[end] += 1;
    }
  }
  return metrics;
}

// ── apply ────────────────────────────────────────────────────────────────────

// ── The funnel record's data blocks ──────────────────────────────────────────
// Built here, not in the store, so the one decision in them that is easy to get
// wrong — the trial window (#2551) — is unit-tested with the rest of the
// importer. The store spreads these into its `create`/`update` verbatim.

/** What a funnel write needs besides the plan: ids the store knows, and its clock. */
export interface FunnelWriteContext {
  orgId: string | null;
  companyId: string;
  /** The row's clock — when the record enters `toStage`. */
  now: Date;
  /** The org's resolved `trialLengthDays` setting. */
  trialLengthDays: number;
}

/**
 * The `create` data of a funnel record placed at `funnel.toStage`. A record
 * created straight into TRIAL_ACTIVE gets its trial window here: the import
 * never calls `emitStageChange()` (stand-in leads must not be notified), so no
 * later hook would ever stamp it.
 *
 * The file's own dates (#2554) come first and the automatic stamp only fills
 * what they leave open — `trialWindowFor` is asked with the file's dates as the
 * record's "existing" window, so an explicit `trial_ends_at` is never replaced
 * and an explicit `trial_started_at` alone gets its end counted from itself.
 * `customer_since` becomes `startDate`; without it the column's own default
 * (the insert) stands.
 */
export function funnelRelationCreateData(
  funnel: Pick<MarketingFunnelPlan, 'ownerId' | 'toStage'> & Partial<Pick<MarketingFunnelPlan, 'relationChanges'>>,
  leadId: string,
  context: FunnelWriteContext,
): {
  orgId: string | null;
  mentorId: string;
  menteeId: string;
  companyId: string;
  pipelineStatus: string;
} & TrialWindowData &
  MarketingRelationWrite {
  const explicit = funnel.relationChanges ?? {};
  return {
    orgId: context.orgId,
    mentorId: funnel.ownerId,
    menteeId: leadId,
    companyId: context.companyId,
    pipelineStatus: funnel.toStage,
    ...explicit,
    ...trialWindowFor({
      toStage: funnel.toStage,
      enteredAt: context.now,
      existing: { trialStartedAt: explicit.trialStartedAt ?? null, trialEndsAt: explicit.trialEndsAt ?? null },
      lengthDays: context.trialLengthDays,
    }),
  };
}

/**
 * The `update` data of an existing funnel record. The window is stamped only
 * on a real move into TRIAL_ACTIVE — re-applying the stage a record already
 * sits at is not an entry, and would date a trial from the day of the re-run —
 * and never over a window the record already has.
 *
 * The file's dates (#2554) are written whether or not the stage moves — they
 * were planned against the record by `planFieldUpdates` (gaps only unless
 * authoritative) — and the automatic stamp sees them as part of the window, so
 * it can only fill what neither the record nor the file has.
 */
export function funnelRelationUpdateData(
  funnel: Pick<MarketingFunnelPlan, 'toStage'> & Partial<Pick<MarketingFunnelPlan, 'relationChanges'>>,
  current: ({ pipelineStatus: string } & ExistingTrialWindow) | null,
  context: Omit<FunnelWriteContext, 'orgId'>,
): { pipelineStatus: string; companyId: string } & TrialWindowData & MarketingRelationWrite {
  const explicit = funnel.relationChanges ?? {};
  const moving = !current || current.pipelineStatus !== funnel.toStage;
  const window: ExistingTrialWindow = {
    trialStartedAt: explicit.trialStartedAt ?? current?.trialStartedAt ?? null,
    trialEndsAt: explicit.trialEndsAt ?? current?.trialEndsAt ?? null,
  };
  return {
    pipelineStatus: funnel.toStage,
    companyId: context.companyId,
    ...explicit,
    ...(moving
      ? trialWindowFor({
          toStage: funnel.toStage,
          enteredAt: context.now,
          existing: window,
          lengthDays: context.trialLengthDays,
        })
      : {}),
  };
}

/**
 * The write side of one chunk. The store implements it inside a transaction;
 * `previewWriter` implements it as nothing at all, which is the entire
 * difference between a dry run and a real one.
 *
 * Both methods return the Company id they wrote (null in a preview).
 */
export interface MarketingAccountWriter {
  createAccount(row: MarketingPlannedRow): Promise<string | null>;
  updateAccount(row: MarketingPlannedRow): Promise<string | null>;
}

/** The dry-run writer: same plan, same report, no writes. */
export const previewWriter: MarketingAccountWriter = {
  async createAccount() {
    return null;
  },
  async updateAccount(row) {
    return row.targetId ?? null;
  },
};

// ── Create-only: the hand-typed lead (#2562) ────────────────────────────────

/**
 * Why a create-only row was not written although it planned a CREATE: its
 * contact already carries an ACTIVE funnel record. The import re-points that
 * record at the new account (a spreadsheet row saying "this contact now
 * belongs to that merchant"); a person typing one lead into a form almost
 * certainly means a second, different account, and silently moving somebody's
 * funnel card there is the wrong default. The form sends them to the lead.
 */
export const CONTACT_IN_FUNNEL = 'contact_in_funnel';

/**
 * Why a hand-typed lead was refused before planning: its contact address is a
 * staff user (ADMIN, MENTOR, COMPANY) of the same organization — almost always
 * the admin's own address or a colleague's typed into the wrong field. The
 * import in the same situation creates a separate stand-in lead (staff is
 * never matched as a lead); a form asks the person instead.
 */
export const CONTACT_IS_USER = 'contact_is_user';

/**
 * The create-only plan: identical to the import's, except that a CREATE whose
 * contact is already on the funnel becomes a SKIP (see above). UPDATE and
 * UNCHANGED rows pass through unchanged — they are the "already exists" answer
 * and `createOnlyWriter` does not write them.
 */
export function createOnlyPlan(rows: MarketingPlannedRow[]): MarketingPlannedRow[] {
  return rows.map((row) =>
    row.status === 'CREATE' && row.value.funnel?.relationId
      ? { ...row, status: 'SKIP' as const, reason: CONTACT_IN_FUNNEL }
      : row,
  );
}

/**
 * A writer that CREATES through `writer` and never updates: an UPDATE is what
 * the matched, existing account WOULD receive, so it is reported (with the
 * account's id) and not written — the dry-run half of the same writer port.
 */
export function createOnlyWriter(writer: MarketingAccountWriter): MarketingAccountWriter {
  return { createAccount: (row) => writer.createAccount(row), updateAccount: previewWriter.updateAccount };
}

/**
 * What an operator reads when a row is refused.
 *
 * `AlreadyMentoredError` is the one refusal this design cares most about — the
 * lead already belongs to another owner, and re-pointing `mentorId` in place
 * would re-attribute that owner's work (docs/mentor-transfer.md). Its message
 * is the literal `already_mentored`: the right thing for an API to answer as a
 * code, and useless in a CLI report. Matched on `name` rather than `instanceof`
 * so this module stays free of the Prisma-aware half.
 */
export function writeFailureReason(error: unknown, row: MarketingPlannedRow): string {
  if (error instanceof Error && error.name === 'AlreadyMentoredError') {
    const contact = row.value.funnel?.emailKey ?? 'the contact';
    return `${contact} already has an active owner in this organization — transfer the record instead of importing it (already_mentored)`;
  }
  return importErrorMessage(error);
}

/**
 * Apply the planned rows of one chunk through `writer` and report each outcome.
 *
 * A row that throws is recorded as ERROR with its message and the chunk carries
 * on — one refused row (an owner conflict, a unique-index clash) must not cost
 * the other ninety-nine. A failure the *transaction* cannot survive propagates,
 * and `runImport` marks the whole chunk ERROR after it has rolled back.
 */
export async function applyPlannedAccounts(
  rows: MarketingPlannedRow[],
  writer: MarketingAccountWriter,
): Promise<RowResult<MarketingPlanValue>[]> {
  const results: RowResult<MarketingPlanValue>[] = [];
  for (const row of rows) {
    if (row.value.refused) {
      results.push({ row: row.row, key: row.key, status: 'ERROR', reason: row.value.refused, value: row.value });
      continue;
    }
    if (row.status === 'UNCHANGED' || row.status === 'SKIP') {
      results.push({
        row: row.row,
        key: row.key,
        status: row.status,
        targetId: row.targetId ?? null,
        ...(row.reason ? { reason: row.reason } : {}),
        value: row.value,
      });
      continue;
    }
    try {
      const targetId =
        row.status === 'CREATE' ? await writer.createAccount(row) : await writer.updateAccount(row);
      results.push({
        row: row.row,
        key: row.key,
        status: row.status,
        targetId,
        changed: row.changed ?? [],
        ...(row.reason ? { reason: row.reason } : {}),
        value: row.value,
      });
    } catch (error) {
      results.push({
        row: row.row,
        key: row.key,
        status: 'ERROR',
        reason: writeFailureReason(error, row),
        value: row.value,
      });
    }
  }
  return results;
}
