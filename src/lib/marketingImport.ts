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
// THE MATCH KEY (#2405)
//   VAT id first — the strongest identity a merchant has across systems — then
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
  type PlannedRow,
  type ResolveResult,
  type RowResult,
  type ValidatedRow,
} from './importPreview';
import { normalizeEmailKey, normalizeNameKey, normalizePhoneKey } from './duplicateDetection';
import { isPlaceholderEmail, PLACEHOLDER_EMAIL_DOMAIN } from './menteeAccount';
import { planFieldUpdates } from './externalSyncPolicy';
import { TEXT_LIMITS } from './textLimits';

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

/** The identity a row claims: its VAT key, else its name+country key. */
export function accountMatchKey(row: { name: string; country: string; vatId: string }): string {
  const vat = normalizeVatKey(row.vatId);
  return vat ? `vat:${vat}` : `name:${accountNameKey(row.name, row.country)}`;
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
}

export interface MarketingRelationTarget {
  id: string;
  mentorId: string;
  menteeId: string;
  companyId: string | null;
  pipelineStatus: string;
  /** Only ACTIVE relations are the funnel record; a COMPLETED one is history. */
  status: string;
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
  /** Existing ACTIVE relation with this owner, or null when one is created. */
  relationId: string | null;
  /** The relation's stage today; null when the relation is being created. */
  fromStage: string | null;
  toStage: string;
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
}

interface AccountIndex<T extends AccountLike> {
  byVat: Map<string, T>;
  byNameCountry: Map<string, T>;
  /** Every account under its name alone — the loose half of the key. */
  byName: Map<string, T[]>;
}

function emptyAccountIndex<T extends AccountLike>(): AccountIndex<T> {
  return { byVat: new Map(), byNameCountry: new Map(), byName: new Map() };
}

function indexAccount<T extends AccountLike>(index: AccountIndex<T>, account: T): void {
  const vat = normalizeVatKey(account.vatId);
  if (vat && !index.byVat.has(vat)) index.byVat.set(vat, account);
  const nameCountry = accountNameKey(account.name, account.country ?? '');
  if (!index.byNameCountry.has(nameCountry)) index.byNameCountry.set(nameCountry, account);
  const nameOnly = normalizeNameKey(account.name);
  const bucket = index.byName.get(nameOnly);
  if (bucket) bucket.push(account);
  else index.byName.set(nameOnly, [account]);
}

type AccountMatch<T> = { kind: 'none' } | { kind: 'one'; target: T } | { kind: 'ambiguous'; count: number };

/** VAT id first, then name+country, then the loose name half described above. */
function matchAccount<T extends AccountLike>(
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
  const seenLeadKeys = new Map<string, number>();

  const skip = (row: number, key: string, value: MarketingAccountRow, reason: string) => {
    plan.push({
      row,
      key,
      status: 'SKIP',
      reason,
      value: { input: value, account: { targetId: null, changes: {}, changed: [], withheld: [] }, funnel: null, warnings: [] },
    });
  };

  for (const { row, key, value } of rows) {
    // Two rows for the same account in one file: the first wins and the second
    // is reported. Without this the second row races the `@@unique([orgId,
    // vatId])` index and takes its whole chunk down with it. The check is on
    // the account a row RESOLVES to, never on the identity it claims: one file
    // listing a merchant twice — the VAT filled in on one line only — holds two
    // different claimed keys and is still one account.
    const inFile = matchAccount(planned, value);
    if (inFile.kind === 'one') {
      skip(row, key, value, `duplicate account in file (first seen at row ${inFile.target.row})`);
      continue;
    }
    if (inFile.kind === 'ambiguous') {
      skip(row, key, value, `duplicate account in file (matches ${inFile.count} earlier rows by name; add a country or vat_id)`);
      continue;
    }

    const found = matchAccount(index, value);
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
        skip(row, key, value, `duplicate account in file (first seen at row ${claimed})`);
        continue;
      }
      claimedBy.set(target.id, row);
    } else {
      indexAccount(planned, { row, name: value.name, vatId: value.vatId || null, country: value.country || null });
    }

    const incoming: MarketingAccountWrite = {
      name: value.name,
      vatId: blankToUndefined(value.vatId),
      country: blankToUndefined(value.country),
      industry: blankToUndefined(value.industry),
      contactName: blankToUndefined(value.contactName),
      contactEmail: blankToUndefined(value.contactEmail),
      contactPhone: blankToUndefined(value.contactPhone),
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

    const status = target
      ? accountChanged.length > 0 || funnel?.pending
        ? 'UPDATE'
        : 'UNCHANGED'
      : 'CREATE';

    const reason = [
      ...(withheld.length > 0 ? [`left alone: ${withheld.join(', ')}`] : []),
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
  else fields.push(...funnel.leadChanged.map((f) => `lead.${f}`));
  if (!funnel.relationId) fields.push('funnelRecord');
  else if (funnel.fromStage !== funnel.toStage) fields.push('pipelineStatus');
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
): MarketingFunnelPlan | null {
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

  const toStage = value.stage;
  const fromStage = relation ? relation.pipelineStatus : null;
  const relationCompanyDiffers =
    relation !== null && target !== undefined && relation.companyId !== target.id;

  const pending =
    !lead ||
    leadChanged.length > 0 ||
    relation === null ||
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
    relationId: relation?.id ?? null,
    fromStage,
    toStage,
    pending,
  };
}

// ── apply ────────────────────────────────────────────────────────────────────

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
