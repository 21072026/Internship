// Postal campaigns (Briefwerbung) — THE rule (#2697).
//
// In Germany the letter is the one lawful COLD outbound channel to a business:
// e-mail, LinkedIn/XING messages and list-dialled phone calls need a consent we
// do not have (UWG § 7 Abs. 2), while a letter needs none under the UWG — only
// the DSGVO record (Art. 6 Abs. 1 lit. f, Art. 14, Art. 21). The channel table
// is docs/marketing-vertical/outreach-compliance.md § 2; this file decides, per
// account, whether a letter may go out, what the address block and the letter
// say, and which keys an objection blocks for good.
//
// Dependency-free and unit-tested (scripts/test/post-campaign.test.mjs). The
// Prisma half is src/lib/postCampaign.ts. Not legal advice: the texts below are
// the engineering default and wait for the same Fachanwalt review as the
// channel-rules document.

import { ownerObjected } from './contactPermissionRule';

/** A letter to the same account at most once in this many days. A campaign that
 *  lands on one shop every fortnight is the "unzumutbare Belästigung" § 7 Abs. 1
 *  UWG still forbids for letters. */
export const POST_COOLDOWN_DAYS = 90;

/** Why an account may NOT receive a campaign letter; `null` = it may. */
export type PostIneligibility =
  /** No postal address on the account — nothing to print on the envelope. */
  | 'no_address'
  /** The owner objected (Art. 21): the opt-out link or a recorded objection. */
  | 'objected'
  /** Somebody here revoked the POST channel for this account. */
  | 'revoked'
  /** On the block list — an objection that outlived its account row. */
  | 'suppressed'
  /** Already sent a letter within POST_COOLDOWN_DAYS. */
  | 'recently_mailed';

export interface PostEligibilityInput {
  address: string | null | undefined;
  /** The account's POST contact-permission row, if any. */
  postPermission: { basis?: string; revokedAt: Date | null; revokedVia?: string | null } | null;
  /** Any of the account's keys on the block list for POST. */
  suppressed: boolean;
  /** When the account last received a sent campaign letter. */
  lastSentAt: Date | null;
  now: Date;
}

/**
 * May this account receive a letter now? Order matters only for the reason
 * shown: an objection is reported as one even when the account also lacks an
 * address, because that is the fact the admin must not work around.
 */
export function postIneligibility(input: PostEligibilityInput): PostIneligibility | null {
  const permission = input.postPermission
    ? { basis: (input.postPermission.basis ?? 'NONE') as 'NONE', revokedAt: input.postPermission.revokedAt, revokedVia: input.postPermission.revokedVia }
    : null;
  if (ownerObjected(permission)) return 'objected';
  if (input.suppressed) return 'suppressed';
  if (permission?.revokedAt) return 'revoked';
  if (!input.address || !input.address.trim()) return 'no_address';
  if (input.lastSentAt && input.now.getTime() - input.lastSentAt.getTime() < POST_COOLDOWN_DAYS * 86_400_000) {
    return 'recently_mailed';
  }
  return null;
}

// ── Campaign code ───────────────────────────────────────────────────────────

/** utm_campaign and the short path /b/<code>: lower-case letters, digits, dashes. */
export const CAMPAIGN_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** A code from a campaign name: "Herbst 2026 – Shop-Händler" → "herbst-2026-shop-handler". */
export function campaignCodeFrom(name: string): string {
  const code = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return code || 'kampagne';
}

/** Where the short link sends a reader: the landing's demo form, attributed to
 *  the letter (`utm:brief/post/<code>` as the lead's Source — src/lib/leadSourceName.ts). */
export function campaignLandingPath(code: string): string {
  return `/?utm_source=brief&utm_medium=post&utm_campaign=${encodeURIComponent(code)}#demo`;
}

/** The link printed on the letter: short enough to type off paper. */
export function campaignShortLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/b/${code}`;
}

// ── The address block (DIN 5008, window envelope) ───────────────────────────

/** DIN 5008's address field holds six lines below the return-address line. */
export const ADDRESS_BLOCK_MAX_LINES = 6;

/**
 * The recipient block as printed. Company, then the contact person ("z. Hd."),
 * then the free-text address split on line breaks or commas; a foreign country
 * gets its own last line, a German one none (DIN 5008: the destination country
 * is written only for mail leaving the country). Returns null without an address.
 */
export function addressBlock(input: {
  companyName: string;
  contactName?: string | null;
  address: string | null | undefined;
  country?: string | null;
  countryName?: (code: string) => string;
}): string[] | null {
  const address = (input.address ?? '').trim();
  if (!address) return null;
  const lines: string[] = [input.companyName.trim()];
  if (input.contactName && input.contactName.trim()) lines.push(`z. Hd. ${input.contactName.trim()}`);
  const addressLines = address
    .split(/\r?\n|,|\|/)
    .map((l) => l.trim())
    .filter(Boolean);
  lines.push(...addressLines);
  const country = (input.country ?? '').trim().toUpperCase();
  if (country && country !== 'DE') lines.push((input.countryName?.(country) ?? country).toUpperCase());
  return lines.slice(0, ADDRESS_BLOCK_MAX_LINES);
}

// ── The letter ──────────────────────────────────────────────────────────────

/** The placeholders a letter body may use. */
export const LETTER_PLACEHOLDERS = ['{company}', '{salutation}', '{link}'] as const;

/**
 * "Guten Tag Max Mustermann," when we know who reads it; the neutral form
 * otherwise. Never "Herr"/"Frau": a name does not tell you which is right.
 */
export function salutation(contactName: string | null | undefined): string {
  const name = (contactName ?? '').trim();
  return name ? `Guten Tag ${name},` : 'Sehr geehrte Damen und Herren,';
}

export function renderLetter(body: string, vars: { company: string; contactName?: string | null; link: string }): string {
  return body
    .replaceAll('{salutation}', salutation(vars.contactName))
    .replaceAll('{company}', vars.company)
    .replaceAll('{link}', vars.link);
}

// ── The block list ──────────────────────────────────────────────────────────

function norm(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9@.]+/g, '');
}

/**
 * The identifying keys an objection blocks — before hashing. Several, because a
 * deleted account comes back through an import or a new enquiry under any one
 * of them: the VAT id, the name with its country, the contact e-mail and the
 * postal address. A legal-form suffix is not stripped on purpose ("Müller GmbH"
 * and "Müller KG" are two businesses); whitespace, case and accents are.
 */
export function suppressionKeys(input: {
  vatId?: string | null;
  name?: string | null;
  country?: string | null;
  contactEmail?: string | null;
  address?: string | null;
}): string[] {
  const keys = new Set<string>();
  const vat = norm(input.vatId ?? '');
  if (vat.length >= 4) keys.add(`vat:${vat}`);
  const name = norm(input.name ?? '');
  if (name.length >= 2) keys.add(`name:${name}|${norm(input.country ?? '') || '-'}`);
  const email = (input.contactEmail ?? '').trim().toLowerCase();
  if (email.includes('@')) keys.add(`email:${email}`);
  const address = norm(input.address ?? '');
  if (address.length >= 6) keys.add(`addr:${address}`);
  return [...keys];
}
