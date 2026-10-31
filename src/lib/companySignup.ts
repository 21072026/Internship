// Public employer sign-up (#1865, docs/company-verification.md) — the pure
// half: what a work address is, and what a sign-up may claim. No Prisma; unit-
// tested in scripts/test/company-verification.test.mjs.
//
// A company that signs itself up is created PENDING and reaches no candidate
// until an admin (or a domain proof) clears it. Refusing free-mail addresses is
// the first, cheap filter: a real employer has a domain of its own, and the
// domain is what the proof is later checked against.

/**
 * Consumer mailbox providers. Not exhaustive and not meant to be: it catches
 * the addresses a fake "recruiter" reaches for first. A domain missing here is
 * still PENDING and still reviewed by a person.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'hotmail.co.uk', 'live.com', 'live.de', 'msn.com',
  'yahoo.com', 'yahoo.de', 'yahoo.co.uk', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aol.de',
  'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'gmx.com',
  'web.de', 'freenet.de', 't-online.de', 'posteo.de', 'mailbox.org',
  'yandex.com', 'yandex.ru', 'mail.ru',
  'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.io',
  'zoho.com', 'gmx.fr', 'laposte.net', 'orange.fr',
  'mynet.com', 'hotmail.com.tr', 'outlook.com.tr', 'yandex.com.tr',
]);

/** The lower-cased domain of an address, or null when it has none. */
export function emailDomain(email: string): string | null {
  const at = email.trim().toLowerCase().lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.trim().toLowerCase().slice(at + 1);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.toLowerCase());
}

/** Minimum render-to-submit time for the public form: a person cannot fill it faster. */
export const SIGNUP_MIN_FILL_MS = 3000;

export type SignupRefusal = 'free_mail_domain' | 'invalid_email';

/** The address check the route runs before anything touches the database. */
export function checkSignupEmail(email: string): { ok: true; domain: string } | { ok: false; code: SignupRefusal } {
  const domain = emailDomain(email);
  if (!domain) return { ok: false, code: 'invalid_email' };
  if (isFreeMailDomain(domain)) return { ok: false, code: 'free_mail_domain' };
  return { ok: true, domain };
}

/** A submit faster than a person could type, or a filled honeypot: dropped silently. */
export function looksAutomated(input: { honeypot?: string | null; renderedAt?: number | null; now: number }): boolean {
  if (input.honeypot && input.honeypot.trim()) return true;
  if (typeof input.renderedAt === 'number' && input.now - input.renderedAt < SIGNUP_MIN_FILL_MS) return true;
  return false;
}

// ── Domain proof (the fast path past admin review) ──────────────────────────
//
// A PENDING company that publishes `<DOMAIN_PROOF_PREFIX><token>` as a DNS TXT
// record on its sign-up domain is VERIFIED without waiting for a person. The
// token is derived from the company id with a server secret
// (src/lib/companyDomainProof.ts), so nothing extra is stored and a token for
// one company proves nothing for another.

export const DOMAIN_PROOF_PREFIX = 'interncrm-verification=';

export function domainProofRecord(token: string): string {
  return `${DOMAIN_PROOF_PREFIX}${token}`;
}

/** `resolveTxt()` answers chunked strings per record; a record matches when its joined chunks equal the expected value. */
export function txtRecordsContain(records: readonly (readonly string[])[], expected: string): boolean {
  return records.some((chunks) => chunks.join('').trim() === expected);
}

// ── The onboarding checklist on /company ────────────────────────────────────
//
// DERIVED, never stored: each item is a question about the live data, so it
// cannot go stale and there is no "mark as done" to drift from reality. The
// card disappears when every item is done.

export interface OnboardingFacts {
  logoUrl: string | null;
  description: string | null;
  industry: string | null;
  size: string | null;
  requisitionCount: number;
  verificationStatus: string;
}

// "Invite a teammate" joins this list with team seats (#1870): until a COMPANY
// user can invite anyone, an item they cannot tick would be a dead end.
export const ONBOARDING_ITEMS = ['profile', 'requisition', 'verified'] as const;
export type OnboardingItem = (typeof ONBOARDING_ITEMS)[number];

export function onboardingChecklist(f: OnboardingFacts): Record<OnboardingItem, boolean> {
  const filled = (v: string | null) => !!v && v.trim().length > 0;
  return {
    profile: filled(f.logoUrl) && filled(f.description) && filled(f.industry) && filled(f.size),
    requisition: f.requisitionCount > 0,
    verified: f.verificationStatus === 'VERIFIED',
  };
}

export function onboardingComplete(list: Record<OnboardingItem, boolean>): boolean {
  return ONBOARDING_ITEMS.every((item) => list[item]);
}
