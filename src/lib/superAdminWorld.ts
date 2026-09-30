// Super admin is PER WORLD (docs/worlds.md § Super admin, #2590 follow-up).
//
// The maintainer's rule: the INTERNSHIP super admin and the MARKETING super
// admin are different accounts, each sees and manages only the organizations of
// its own product, and a super-admin session is inert on the other world's host.
// One person may still hold both powers — as two accounts, one per world, the
// same way they hold two ordinary accounts (userWorld.ts).
//
// This module is the PURE half of that rule, so `node --test` can pin it
// (scripts/test/super-admin-world.test.mjs). The Prisma/request half — reading
// the flag live and the request's host — is src/lib/superAdmin.ts.
//
// Imports only the zero-dependency catalogue, relatively.

import { DEFAULT_VERTICAL, VERTICAL_KEYS, toVerticalKey, type VerticalKey } from './verticals';

/**
 * The organizations of one world, as a Prisma `where` fragment — the org-level
 * mirror of `worldUserWhere` (userWorld.ts). A non-default world is exactly its
 * vertical; the DEFAULT world is every organization that is not one of the
 * others, which includes a row carrying a key nobody registered (toVerticalKey
 * reads it as the default).
 */
export function orgWorldWhere(world: VerticalKey): { vertical: string } | { NOT: { vertical: { in: string[] } } } | Record<string, never> {
  const w = toVerticalKey(world);
  if (w !== DEFAULT_VERTICAL) return { vertical: w };
  const others = VERTICAL_KEYS.filter((k) => k !== DEFAULT_VERTICAL);
  return others.length ? { NOT: { vertical: { in: others } } } : {};
}

/** Is an organization of `vertical` (as stored, possibly unknown) inside `world`? */
export function orgInWorld(vertical: unknown, world: VerticalKey): boolean {
  return toVerticalKey(vertical) === toVerticalKey(world);
}

export interface SuperAdminFacts {
  /** The live `User.isSuperAdmin` of the session's row. */
  flag: boolean;
  /** The live `User.isActive`. */
  active: boolean;
  /** The session's role (only an ADMIN can be a super admin). */
  role: string | null | undefined;
  /** The world of the caller's OWN organization (live). */
  callerWorld: VerticalKey;
  /** The world of the host the request arrived on; null = no request (fail closed). */
  requestWorld: VerticalKey | null;
}

/**
 * The world a super admin may act in, or null when this is no super admin HERE.
 * Null when: not an active flagged ADMIN; no request host to compare with; or
 * the request arrived on the OTHER world's host — the power is inert there,
 * whatever the token says.
 */
export function superAdminWorldFrom(facts: SuperAdminFacts): VerticalKey | null {
  if (facts.role !== 'ADMIN' || !facts.flag || !facts.active) return null;
  if (facts.requestWorld === null) return null;
  if (toVerticalKey(facts.requestWorld) !== toVerticalKey(facts.callerWorld)) return null;
  return toVerticalKey(facts.callerWorld);
}

/** May a super admin of `callerWorld` act on an organization of `targetVertical`? */
export function superAdminReaches(callerWorld: VerticalKey | null, targetVertical: unknown): boolean {
  return callerWorld !== null && orgInWorld(targetVertical, callerWorld);
}

/**
 * The vertical a super admin's CREATE lands in. Explicit is required; one that
 * names another world is refused (null) rather than silently rewritten, so a
 * form bug cannot create a tenant in a product the operator did not pick.
 */
export function creatableVertical(callerWorld: VerticalKey, requested: unknown): VerticalKey | null {
  if (typeof requested !== 'string' || !VERTICAL_KEYS.includes(requested as VerticalKey)) return null;
  return orgInWorld(requested, callerWorld) ? (requested as VerticalKey) : null;
}
