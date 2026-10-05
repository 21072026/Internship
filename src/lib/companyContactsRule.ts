/**
 * The address book of an account (#2442) — the rule, dependency-free.
 *
 * ONE PRIMARY, BY CONSTRUCTION. The primary contact is not a row: it is the
 * four `Company.contact*` columns (name, email, phone, position) that the
 * contact permission (#2577), letter campaigns, the import, the export and the
 * erasure rule already read. `CompanyContact` rows are everyone else. So there
 * is no `isPrimary` flag that two requests could both set — making a row
 * primary SWAPS it with the columns (`primarySwap`), and the Prisma half does
 * that inside one transaction holding the company row's lock
 * (src/lib/companyContacts.ts). docs/company-contacts.md has the trade-off.
 *
 * Unit-tested without a database: scripts/test/company-contacts.test.mjs.
 */

export type ContactFields = {
  name: string;
  email: string | null;
  phone: string | null;
  position: string | null;
};

/** The primary contact as the Company row carries it. */
export type PrimaryColumns = {
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactPosition: string | null;
};

/** The id the API and the UI use for the primary contact, which has no row. */
export const PRIMARY_CONTACT_ID = 'primary';

const blankToNull = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t ? t : null;
};

/**
 * Trim every field, blank → null, and lower-case the address: the address is
 * what the per-company uniqueness and the erasure match on, and both compare
 * lower-case (`normalizeContactEmail` in companyContactErasure.ts).
 */
export function normalizeContact(input: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  position?: string | null;
}): ContactFields {
  const email = blankToNull(input.email);
  return {
    name: (input.name ?? '').trim(),
    email: email ? email.toLowerCase() : null,
    phone: blankToNull(input.phone),
    position: blankToNull(input.position),
  };
}

/** Does the account have a primary contact at all? */
export function hasPrimary(company: PrimaryColumns): boolean {
  return !!(company.contactName || company.contactEmail || company.contactPhone || company.contactPosition);
}

/** The primary columns as contact fields (a nameless primary reads as its address). */
export function primaryAsContact(company: PrimaryColumns): ContactFields {
  return {
    name: company.contactName?.trim() || company.contactEmail || '',
    email: company.contactEmail ? company.contactEmail.toLowerCase() : null,
    phone: company.contactPhone,
    position: company.contactPosition,
  };
}

/** Contact fields written into the primary columns. */
export function contactAsPrimary(contact: ContactFields): PrimaryColumns {
  return {
    contactName: contact.name || null,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    contactPosition: contact.position,
  };
}

/**
 * Make `chosen` the primary contact. Returns what the Company columns become
 * and the row the previous primary turns into — `null` when there was no
 * previous primary, so nobody is invented. The caller deletes the chosen row
 * and creates `demoted` as a NEW row (a new id): reusing the chosen row's id
 * for the previous primary would make a repeated "make X primary" request
 * silently swap the two back.
 */
export function primarySwap(
  company: PrimaryColumns,
  chosen: ContactFields,
): { primary: PrimaryColumns; demoted: ContactFields | null } {
  return {
    primary: contactAsPrimary(chosen),
    demoted: hasPrimary(company) ? primaryAsContact(company) : null,
  };
}

/**
 * Is `email` already in this account's address book — on the primary or on a
 * row other than `exceptId`? A null address never collides (several contacts
 * may have none).
 */
export function emailTaken(
  email: string | null,
  company: PrimaryColumns,
  rows: { id: string; email: string | null }[],
  exceptId?: string,
): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  if (company.contactEmail && company.contactEmail.toLowerCase() === e) return true;
  return rows.some((r) => r.id !== exceptId && !!r.email && r.email.toLowerCase() === e);
}
