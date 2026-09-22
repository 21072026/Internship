// What a company record shows to whom.
//
// WHY THIS EXISTS (#2405/#2407, and it hands the general case to #2431)
//   `GET /api/companies` and `GET /api/companies/[id]` gate on "is there a
//   session" and read the row with `include` and no `select`, so every Company
//   scalar reaches every authenticated user of the tenant — a MENTEE on the
//   portal included. That broad read is a known open issue (#2431, "Firma okuma
//   uçlarını kapsamdan geçir"), and it is not this module's job to close it.
//
//   But the marketing account import adds three columns of a different kind to
//   that row: a tax identification number and a named person's direct line and
//   name. Name, industry and address leaking to a colleague is untidy; a
//   merchant's VAT id and their buyer's mobile number leaking to every portal
//   account is a different category, and shipping the columns without a gate
//   would widen #2431 rather than wait for it.
//
//   So these three are ADMIN-only at the read boundary until #2431 replaces the
//   whole payload with a scoped one. The gate is written here, once, rather
//   than twice in two route files that have already drifted apart.

/** The Company columns only an ADMIN may read. */
export const COMPANY_ADMIN_ONLY_FIELDS = ['vatId', 'contactName', 'contactPhone'] as const;

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
