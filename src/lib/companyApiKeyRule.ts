// What a COMPANY owner's self-served API key may be (#2006). Dependency-free.
//
// A key a COMPANY user mints is bound to their company (`ApiKey.companyId`) and
// can never hold more than the CEILING below: the hiring records that are
// theirs — requisitions, offers, interview requests. Never the org-wide
// candidate list, relationships, interactions or meetings. A request above the
// ceiling is REFUSED (403 `scope_above_ceiling`), never silently narrowed: an
// integration built on a key that quietly got less would fail later, somewhere
// less obvious.
//
// The door (`withApiKey`, src/lib/apiKey.ts) then admits a company-bound key
// only on a route that declares it filters by the key's company
// (`{ companyScoped: true }`) — fail closed, so a new /api/v1 route is closed
// to company keys until it says otherwise, and checks the ceiling again in case
// a row was written some other way.

import type { ApiScope } from './apiScopes';

export const COMPANY_KEY_SCOPE_CEILING: readonly ApiScope[] = ['hiring:read'];

export type CeilingCheck = { ok: true } | { ok: false; above: string[] };

/** Every requested scope must be inside the company ceiling. */
export function checkCompanyScopeCeiling(requested: readonly string[]): CeilingCheck {
  const above = requested.filter((s) => !(COMPANY_KEY_SCOPE_CEILING as readonly string[]).includes(s));
  return above.length === 0 ? { ok: true } : { ok: false, above };
}

/** Whether the door may run a route for this key. */
export function companyKeyAdmitted(key: { companyId: string | null; scopes: readonly string[] }, route: { companyScoped?: boolean }): boolean {
  if (!key.companyId) return true;
  return route.companyScoped === true && checkCompanyScopeCeiling(key.scopes).ok;
}
