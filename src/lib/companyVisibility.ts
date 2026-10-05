// What a company record shows to whom.
//
// WHY THIS EXISTS (#2405/#2407, alongside the row scope of #2431)
//   Two different questions guard a company payload, and they are answered in
//   two different places:
//
//     * WHICH ROWS a reader may see is `scopeForRole(user, 'company')` in
//       src/lib/authzScope.ts (#2431, landed): ADMIN everything, COMPANY its
//       own row, MENTOR the companies of its own relations, MENTEE and SOURCE
//       refused outright.
//     * WHICH COLUMNS of a row it may see is this module.
//
//   The row scope alone is not enough for the three columns the marketing
//   account import adds. A MENTOR legitimately reads the companies of their own
//   relations — name, industry, address — but a merchant's tax identification
//   number and a named buyer's direct line are a different category of data,
//   held for the operator who sells to that account, not for whoever happens to
//   be placed there. So these three stay ADMIN-only at the read boundary.
//
//   Written once, here, rather than twice in two route files that have already
//   drifted apart.

/** The Company columns only an ADMIN may read. */
export const COMPANY_ADMIN_ONLY_FIELDS = ['vatId', 'contactName', 'contactPhone', 'contactPosition'] as const;

/**
 * The address-book columns (#2442) only an ADMIN may read — the same split as
 * the primary contact's columns above: a reader who may see the account sees
 * which addresses it has, not who the named people are or their direct lines.
 */
export const COMPANY_CONTACT_ADMIN_ONLY_FIELDS = ['name', 'phone', 'position'] as const;

/** `redactCompanyForReader` for one address-book entry. */
export function redactContactForReader<T extends Record<string, unknown>>(contact: T, role: string | undefined): T {
  if (role === 'ADMIN') return contact;
  const copy = { ...contact };
  for (const field of COMPANY_CONTACT_ADMIN_ONLY_FIELDS) delete copy[field];
  return copy;
}

/**
 * Strip the ADMIN-only columns unless the reader is an ADMIN. The fields are
 * REMOVED, not blanked: `undefined` would serialize away anyway, and a `null`
 * would tell a non-admin the column is empty when it is not.
 */
export function redactCompanyForReader<T extends Record<string, unknown>>(
  company: T,
  role: string | undefined,
): T {
  if (role === 'ADMIN') return company;
  const copy = { ...company };
  for (const field of COMPANY_ADMIN_ONLY_FIELDS) delete copy[field];
  return copy;
}
