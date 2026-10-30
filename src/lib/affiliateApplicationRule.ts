// A partner application from the public form (docs/affiliate-module.md, #3361)
// — pure and dependency-free (scripts/test/affiliate-application-rule.test.mjs).
//
// The form asks what a programme needs to decide, and no more: a name, an
// address to answer, optionally a company and a phone number, and how the
// person heard of the programme. No password and no username — nobody gets an
// account from this form; an admin decides (#3362), and an approval goes
// through the ordinary partner invitation (#3117). Consent to the privacy
// notice is required and checked here, not only in the browser: a UI-only
// check is not a consent record (GDPR Art. 7).

/** "How did you hear about us?" — the codes a row stores; the labels are in the dictionary. */
export const AFFILIATE_HEARD_FROM = [
  'search',
  'social',
  'video',
  'recommendation',
  'newsletter',
  'ads',
  'comparison',
  'event',
  'other',
] as const;
export type AffiliateHeardFrom = (typeof AFFILIATE_HEARD_FROM)[number];

export const APPLICATION_LIMITS = {
  name: 80,
  email: 191,
  company: 160,
  phone: 40,
  heardFromOther: 200,
} as const;

export interface AffiliateApplicationInput {
  firstName: string;
  lastName: string;
  /** Lower-cased and trimmed. */
  email: string;
  company: string | null;
  phone: string | null;
  heardFrom: AffiliateHeardFrom;
  /** Only kept when heardFrom is `other`. */
  heardFromOther: string | null;
}

export type ApplicationField = keyof AffiliateApplicationInput | 'consent';

export type ApplicationParseResult =
  | { ok: true; application: AffiliateApplicationInput }
  | { ok: false; fields: ApplicationField[] };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Same shape test as the landing's contact address: one @, a dot in the domain, no spaces. */
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>".]+$/;
/** Digits with + ( ) - / . and spaces, a leading + only, at least five digits. */
const PHONE_RE = /^\+?[0-9 ()\-/.]+$/;

/** Validates the untrusted form body. Every refused field at once, in a fixed order. */
export function parseAffiliateApplication(input: unknown): ApplicationParseResult {
  if (!isObject(input)) return { ok: false, fields: ['firstName', 'lastName', 'email', 'heardFrom', 'consent'] };
  const fields: ApplicationField[] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : null);

  const firstName = str(input.firstName);
  if (!firstName || firstName.length > APPLICATION_LIMITS.name) fields.push('firstName');
  const lastName = str(input.lastName);
  if (!lastName || lastName.length > APPLICATION_LIMITS.name) fields.push('lastName');

  const emailRaw = str(input.email);
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  if (!email || email.length > APPLICATION_LIMITS.email || !EMAIL_RE.test(email)) fields.push('email');

  const company = str(input.company) || null;
  if (input.company !== undefined && input.company !== null && typeof input.company !== 'string') fields.push('company');
  else if (company && company.length > APPLICATION_LIMITS.company) fields.push('company');

  const phone = str(input.phone) || null;
  if (input.phone !== undefined && input.phone !== null && typeof input.phone !== 'string') fields.push('phone');
  else if (phone && (phone.length > APPLICATION_LIMITS.phone || !PHONE_RE.test(phone) || (phone.match(/[0-9]/g) ?? []).length < 5)) {
    fields.push('phone');
  }

  const heardFrom = typeof input.heardFrom === 'string' && (AFFILIATE_HEARD_FROM as readonly string[]).includes(input.heardFrom)
    ? (input.heardFrom as AffiliateHeardFrom)
    : null;
  if (!heardFrom) fields.push('heardFrom');
  const other = str(input.heardFromOther) || null;
  if (heardFrom === 'other' && (!other || other.length > APPLICATION_LIMITS.heardFromOther)) fields.push('heardFromOther');

  if (input.consent !== true) fields.push('consent');

  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    application: {
      firstName: firstName as string,
      lastName: lastName as string,
      email: email as string,
      company,
      phone,
      heardFrom: heardFrom as AffiliateHeardFrom,
      heardFromOther: heardFrom === 'other' ? other : null,
    },
  };
}

/**
 * At most this many applications per address and org per day reach the table,
 * whatever their content: the form's per-IP limit stops one sender, this stops
 * one address being used from many.
 */
export const APPLICATIONS_PER_ADDRESS_PER_DAY = 3;

// ── The admin's decision (#3362) ─────────────────────────────────────────────

/**
 * Why an application was declined. Only the code is stored on the row and only
 * its sentence reaches the applicant's mail; an admin's own note goes to the
 * audit row, which the applicant never reads.
 */
export const APPLICATION_REJECTION_CODES = ['not_a_fit', 'duplicate', 'incomplete', 'other'] as const;
export type ApplicationRejectionCode = (typeof APPLICATION_REJECTION_CODES)[number];

export function isRejectionCode(v: unknown): v is ApplicationRejectionCode {
  return typeof v === 'string' && (APPLICATION_REJECTION_CODES as readonly string[]).includes(v);
}

/**
 * A referral-code suggestion from the applicant's name — `ada-example` — that
 * the admin may change before approving. Letters are folded to ASCII (ß → ss,
 * accents dropped), everything else becomes a single dash; the result always
 * matches the partner-code shape (an alphanumeric first character, at most 40
 * characters here). Uniqueness is the writer's question, not this one's.
 */
export function suggestPartnerCode(firstName: string, lastName: string): string {
  const folded = `${firstName} ${lastName}`
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return folded === '' ? 'partner' : folded;
}
