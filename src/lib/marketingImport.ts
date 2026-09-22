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
  /** The lead person's normalized address; also the User's `email`. */
  emailKey: string;
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
  const byVat = new Map<string, MarketingAccountTarget>();
  const byName = new Map<string, MarketingAccountTarget>();
  for (const account of snapshot.accounts) {
    const vat = normalizeVatKey(account.vatId);
    if (vat && !byVat.has(vat)) byVat.set(vat, account);
    const nameKey = accountNameKey(account.name, account.country ?? '');
    if (!byName.has(nameKey)) byName.set(nameKey, account);
  }

  const leadByEmail = new Map<string, MarketingLeadTarget>();
  for (const lead of snapshot.leads) {
    const key = normalizeEmailKey(lead.email);
    if (key && !leadByEmail.has(key)) leadByEmail.set(key, lead);
  }

  const plan: MarketingPlannedRow[] = [];
  const seenAccountKeys = new Map<string, number>();
  const seenLeadKeys = new Map<string, number>();

  for (const { row, key, value } of rows) {
    // Two rows for the same account in one file: the first wins and the second
    // is reported. Without this the second row races the `@@unique([orgId,
    // vatId])` index and takes its whole chunk down with it.
    const firstSeen = seenAccountKeys.get(key);
    if (firstSeen !== undefined) {
      plan.push({
        row,
        key,
        status: 'SKIP',
        reason: `duplicate account in file (first seen at row ${firstSeen})`,
        value: { input: value, account: { targetId: null, changes: {}, changed: [], withheld: [] }, funnel: null, warnings: [] },
      });
      continue;
    }
    seenAccountKeys.set(key, row);

    const vat = normalizeVatKey(value.vatId);
    const target =
      (vat ? byVat.get(vat) : undefined) ?? byName.get(accountNameKey(value.name, value.country));

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

  const lead = deps.leadByEmail.get(emailKey);
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
    // A contact with no name: the address is the only name there is. Better a
    // findable lead than a blank `fullName` on a required column.
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
        reason: importErrorMessage(error),
        value: row.value,
      });
    }
  }
  return results;
}
