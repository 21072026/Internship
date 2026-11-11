// What a people picker may ask GET /api/users for (#1437). Dependency-free so
// the rule is unit-tested without a database (scripts/test/user-picker-query.test.mjs).
//
// The mentor/mentee pickers used to download every user in the tenant — COMPANY
// and SOURCE accounts included — and throw most of it away in the browser: 228 KB
// at 1 000 users, on every visit to three admin screens. A picker now names the
// roles it shows and, when the list can be long, asks for one bounded page that
// matches what the admin typed.

/** The roles a mentorship picker can offer — a COMPANY or SOURCE account never mentors or is mentored. */
export const PICKER_ROLES = ['ADMIN', 'MENTOR', 'MENTEE'] as const;
export type PickerRole = (typeof PICKER_ROLES)[number];

/** The hard ceiling on one searchable page — a dropdown has no use for more. */
export const PICKER_MAX_LIMIT = 50;

/**
 * The roles to return: the `roles` list (comma-separated) narrowed to
 * PICKER_ROLES, intersected with the single `role` filter when one is given.
 * No `roles` means every picker role. Unknown names are ignored rather than
 * refused — they can only narrow — but a list that names none of the picker
 * roles answers an empty set, never the full one.
 */
export function pickerRoles(rolesParam: string | null, roleParam: string | null): PickerRole[] {
  let roles: PickerRole[] = [...PICKER_ROLES];
  if (rolesParam !== null) {
    const asked = new Set(rolesParam.split(',').map((r) => r.trim().toUpperCase()));
    roles = PICKER_ROLES.filter((r) => asked.has(r));
  }
  if (roleParam) roles = roles.filter((r) => r === roleParam);
  return roles;
}

/**
 * The page size, or null for the historical unbounded list. Anything that is
 * not a positive integer is null — a malformed `limit` must not silently turn
 * into a truncated list a caller believes is complete — and a large one is
 * clamped to PICKER_MAX_LIMIT.
 */
export function pickerLimit(limitParam: string | null): number | null {
  if (limitParam === null || !/^\d+$/.test(limitParam.trim())) return null;
  const n = Number(limitParam.trim());
  if (n < 1) return null;
  return Math.min(n, PICKER_MAX_LIMIT);
}
