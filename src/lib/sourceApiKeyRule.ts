// What a SOURCE owner's self-served API key may be (#2006). Dependency-free.
//
// The same three rules as a company key (src/lib/companyApiKeyRule.ts), over
// the other thing a non-admin owns: a SOURCE (a referring institution) mints a
// key bound to its source (`ApiKey.sourceId`) whose scopes never exceed the
// CEILING below — the candidates it referred, read-only. Never another
// source's candidates, the org-wide list, relationships or hiring records. A
// request above the ceiling is REFUSED (403 `scope_above_ceiling`), never
// narrowed.
//
// The door (`withApiKey`) admits a source-bound key only on a route that
// declares it filters by the key's source (`{ sourceScoped: true }`) — fail
// closed — and checks the ceiling again in case a row was written some other way.

import type { ApiScope } from './apiScopes';

export const SOURCE_KEY_SCOPE_CEILING: readonly ApiScope[] = ['candidates:read'];

export type CeilingCheck = { ok: true } | { ok: false; above: string[] };

/** Every requested scope must be inside the source ceiling. */
export function checkSourceScopeCeiling(requested: readonly string[]): CeilingCheck {
  const above = requested.filter((s) => !(SOURCE_KEY_SCOPE_CEILING as readonly string[]).includes(s));
  return above.length === 0 ? { ok: true } : { ok: false, above };
}

/** Whether the door may run a route for this key. */
export function sourceKeyAdmitted(key: { sourceId: string | null; scopes: readonly string[] }, route: { sourceScoped?: boolean }): boolean {
  if (!key.sourceId) return true;
  return route.sourceScoped === true && checkSourceScopeCeiling(key.scopes).ok;
}
