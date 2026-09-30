// Contact permission — THE rule (#2577, story #2575).
//
// "May we send this account advertising e-mail, and can we prove it?" Germany
// forbids unsolicited advertising e-mail in B2B too (UWG § 7 Abs. 2 Nr. 2), and
// the sanction arrives as an Abmahnung. So the CRM must never suggest, and never
// perform, a marketing contact whose basis it cannot prove.
//
// This file is the whole rule, dependency-free and unit-tested
// (scripts/test/contact-permission.test.mjs). The only Prisma-aware half is
// src/lib/contactPermission.ts, which asks this file before every write. Design
// and the reasons: docs/contact-permission.md. The four basis codes are the same
// terms the channel-rules document (#2576) uses — change one, change both.

export const CONTACT_CHANNELS = ['EMAIL', 'PHONE', 'POST'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const CONTACT_BASES = ['DOI_CONFIRMED', 'EXISTING_CUSTOMER_7_3', 'INQUIRY_REPLY', 'NONE'] as const;
export type ContactBasis = (typeof CONTACT_BASES)[number];

/**
 * Who is writing. The MACHINE writers are the ones nobody watches while they
 * run: the account import (#2405/#2562), the SaleVali usage/merchant feed
 * (#2446) and anything that reads SaleVali's own newsletter flag. SaleVali's
 * registration box is PRE-TICKED (salevali-client Registration.jsx; the Google
 * sign-up path defaults `newsletter = true` server-side) — a pre-ticked box is
 * no consent (CJEU C-673/17 Planet49), and a flag carried over from another
 * product proves nothing about this address owner's will. So a machine may
 * record that it knows of an account's address, and nothing more.
 */
export const MACHINE_WRITERS = ['import', 'ingest', 'salevali-newsletter'] as const;
export type MachineWriter = (typeof MACHINE_WRITERS)[number];
export type ContactPermissionWriter =
  | MachineWriter
  /** The address owner pressing "confirm" behind the link we mailed them. */
  | 'doi'
  /** A demo/contact request placed on the funnel: they asked us something. */
  | 'inquiry'
  /** An admin, by hand, with a reason. */
  | 'admin';

/**
 * Which basis each writer may write. Anything outside its list is refused —
 * loudly, by the store (`ContactPermissionRuleError`), never coerced.
 *
 *  - machines: NONE only;
 *  - the DOI click: DOI_CONFIRMED only;
 *  - an inquiry conversion: INQUIRY_REPLY (answering their request is not
 *    advertising), or DOI_CONFIRMED when the request was ALREADY confirmed
 *    through the link — the conversion only carries that proof over;
 *  - an admin: EXISTING_CUSTOMER_7_3 (with a reason), INQUIRY_REPLY or NONE.
 *    NEVER DOI_CONFIRMED: a double opt-in is a click by the address owner, and
 *    a person cannot type one in on their behalf.
 */
const ALLOWED: Record<ContactPermissionWriter, readonly ContactBasis[]> = {
  import: ['NONE'],
  ingest: ['NONE'],
  'salevali-newsletter': ['NONE'],
  doi: ['DOI_CONFIRMED'],
  inquiry: ['INQUIRY_REPLY', 'DOI_CONFIRMED'],
  admin: ['EXISTING_CUSTOMER_7_3', 'INQUIRY_REPLY', 'NONE'],
};

export function isMachineWriter(writer: ContactPermissionWriter): writer is MachineWriter {
  return (MACHINE_WRITERS as readonly string[]).includes(writer);
}

export type RuleRefusal =
  | 'basis_not_allowed_for_writer'
  | 'owner_objected'
  | 'doi_needs_confirmation'
  | 'reason_required'
  | 'channel_not_email';

/**
 * Checks one intended write. `null` = allowed; otherwise the refusal code.
 * The evidence requirements live here too, so a caller cannot write a basis
 * without the proof that makes it one.
 */
export function refuseWrite(input: {
  writer: ContactPermissionWriter;
  channel: ContactChannel;
  basis: ContactBasis;
  confirmedAt?: Date | null;
  reason?: string | null;
}): RuleRefusal | null {
  const { writer, channel, basis } = input;
  if (!ALLOWED[writer].includes(basis)) return 'basis_not_allowed_for_writer';
  // A double opt-in exists only for e-mail, and only with its click.
  if (basis === 'DOI_CONFIRMED') {
    if (channel !== 'EMAIL') return 'channel_not_email';
    if (!input.confirmedAt) return 'doi_needs_confirmation';
  }
  // § 7(3): an existing PAYING customer, and the admin has to say why — the
  // exception is narrow (an address obtained in the course of a sale; a demo
  // or trial sign-up is not a sale), so the record must name the sale.
  if (basis === 'EXISTING_CUSTOMER_7_3') {
    if (channel !== 'EMAIL') return 'channel_not_email';
    if (!input.reason || input.reason.trim().length < MIN_REASON_LENGTH) return 'reason_required';
  }
  return null;
}

/** A reason shorter than this is a placeholder, not a reason. */
export const MIN_REASON_LENGTH = 10;

/** How "strong" a basis is, for deciding whether a write replaces a row. */
const RANK: Record<ContactBasis, number> = {
  NONE: 0,
  INQUIRY_REPLY: 1,
  EXISTING_CUSTOMER_7_3: 2,
  DOI_CONFIRMED: 3,
};

export interface ExistingPermission {
  basis: ContactBasis;
  revokedAt: Date | null;
  /** 'LINK' = the address owner withdrew; 'ADMIN' = somebody here did. */
  revokedVia?: string | null;
}

/**
 * Did the address owner themself object (the opt-out link)? Then the row is
 * LOCKED: nobody here may write over it at all — not an advertising basis
 * (§ 7(3) itself ends at an objection) and not a neutral one either, because
 * any write replaces the row's revocation and a neutral write would be step one
 * of a two-step re-grant (NONE clears the objection, § 7(3) then goes through).
 * Only the person can lift it, by confirming a request AFTER the objection
 * (`doi`, see `writeReplaces`).
 */
export function ownerObjected(existing: ExistingPermission | null): boolean {
  return !!existing?.revokedAt && existing.revokedVia === 'LINK';
}

/**
 * Does a write replace what is stored?
 *
 *  - Nothing stored: yes.
 *  - A MACHINE write never replaces anything — it only creates the NONE row
 *    when there is none. An import re-run must not erase a confirmed opt-in,
 *    and it must not un-revoke an opt-out either.
 *  - An admin write replaces (they are deciding, with a reason; the
 *    ActivityLog keeps what was there) — except over the address owner's own
 *    withdrawal (`ownerObjected`), which no admin write touches.
 *  - A DOI click is a new, explicit consent by the address owner: it replaces
 *    whatever is there, including an earlier revocation (they opted back in) —
 *    but only when the click itself is LATER than that revocation. A
 *    confirmation dated before the revocation is the consent that was revoked,
 *    not a new one, and replaying it must not undo the revocation.
 *  - An inquiry conversion replaces only a weaker, live basis — it never
 *    downgrades a DOI or a §7(3) record to INQUIRY_REPLY, and never revives a
 *    revoked row (a revocation is the owner's word; a new request is not a
 *    confirmation).
 */
export function writeReplaces(
  writer: ContactPermissionWriter,
  incoming: ContactBasis,
  existing: ExistingPermission | null,
  incomingConfirmedAt?: Date | null,
): boolean {
  if (!existing) return true;
  if (isMachineWriter(writer)) return false;
  if (writer === 'doi') {
    if (!existing.revokedAt) return true;
    return !!incomingConfirmedAt && incomingConfirmedAt.getTime() > existing.revokedAt.getTime();
  }
  if (writer === 'admin') return !ownerObjected(existing);
  if (existing.revokedAt) return false;
  return RANK[incoming] > RANK[existing.basis];
}

/** The bases that permit ADVERTISING e-mail. INQUIRY_REPLY does not. */
export const MARKETING_EMAIL_BASES: readonly ContactBasis[] = ['DOI_CONFIRMED', 'EXISTING_CUSTOMER_7_3'];

export interface PermissionRow {
  channel: ContactChannel;
  basis: ContactBasis;
  revokedAt: Date | null;
  confirmedAt?: Date | null;
  address?: string | null;
}

/**
 * THE gate: may this account be sent advertising e-mail at `address`?
 * Every marketing-mail path asks this (through `canSendMarketingEmail` in the
 * store) — and a row for another address does not count: a confirmation is for
 * the address that confirmed, not for whoever the contact is today.
 */
export function marketingEmailAllowed(row: PermissionRow | null | undefined, address?: string | null): boolean {
  if (!row || row.channel !== 'EMAIL' || row.revokedAt) return false;
  if (!MARKETING_EMAIL_BASES.includes(row.basis)) return false;
  if (row.basis === 'DOI_CONFIRMED' && !row.confirmedAt) return false;
  if (address !== undefined) {
    if (!row.address || !address) return false;
    if (normalizeAddress(row.address) !== normalizeAddress(address)) return false;
  }
  return true;
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

// ── Double opt-in ────────────────────────────────────────────────────────────

/** How long a confirmation link works after the request was made. */
export const DOI_CONFIRM_WINDOW_DAYS = 30;

export type DoiRefusal = 'not_requested' | 'opted_out' | 'expired';

/** May this request still be confirmed? `null` = yes. */
export function refuseConfirmation(
  request: { requested: boolean | null; optedOutAt: Date | null; createdAt: Date },
  now: Date,
): DoiRefusal | null {
  if (request.requested !== true) return 'not_requested';
  if (request.optedOutAt) return 'opted_out';
  if (now.getTime() - request.createdAt.getTime() > DOI_CONFIRM_WINDOW_DAYS * 24 * 60 * 60 * 1000) return 'expired';
  return null;
}

/**
 * The per-recipient cap's day key: one confirmation mail per address per UTC
 * calendar day (#2569 § 9). The store hashes the address; the day is here so
 * the boundary is tested.
 */
export function capDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}
