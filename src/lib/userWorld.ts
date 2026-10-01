// Which ACCOUNT is this e-mail, in which WORLD (docs/worlds.md, epic #2348).
//
// `User.email` is no longer globally unique. One person may hold one account in
// the internship world and one in the marketing world — two rows, two tenants,
// two sets of data, one mailbox — and the host they sign in on decides which
// row they are. This module is the ONLY place that turns an e-mail address into
// a user row; every lookup answers "in which world?" or says out loud that it
// deliberately means "in any" (`findUsersByEmail`).
//
// WHY ROWS, NOT MEMBERSHIPS. A single row with several org memberships looks
// tidier and would be the expensive move: `User.orgId` is read by the tenant
// filters (tenantWhere, the Prisma middleware) to decide which users a tenant
// can see, so a user with a foreign orgId disappears from the very screens that
// list their own organization's people, and every mentorship / lead relation
// that joins through `User` breaks the same way. Two rows keep each tenant's
// data model exactly what it was; the only new question is the one this file
// answers.
//
// A WORLD IS DERIVED, NEVER STORED ON THE USER. It is the vertical of the
// user's organization, read at the moment it is needed — the same contract as
// verticalContext.ts — so a super admin changing an organization's product
// moves its people with it, and there is no second copy to drift. A user whose
// `orgId` is still NULL belongs to the default org (the deploy backfill's own
// rule), i.e. the default world.
//
// SERVER-ONLY (Prisma). The pure host → world rule is hostWorld.ts.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { DEFAULT_VERTICAL, VERTICAL_KEYS, toVerticalKey, type VerticalKey } from '@/lib/verticals';
import { verticalFor } from '@/lib/verticalContext';

/** Addresses are stored trimmed and lower-cased (registration, sign-in and every lookup agree). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The users of one world, as a Prisma `where` fragment.
 *
 * A non-default vertical is exactly its organizations' users. The DEFAULT
 * vertical is everything that is not one of the others: that includes users
 * whose organization row carries a key nobody registered (toVerticalKey falls
 * back to the default for them) and users with no organization yet.
 */
export function worldUserWhere(world: VerticalKey): Prisma.UserWhereInput {
  const w = toVerticalKey(world);
  if (w !== DEFAULT_VERTICAL) return { org: { is: { vertical: w } } };
  const others = VERTICAL_KEYS.filter((k) => k !== DEFAULT_VERTICAL);
  return others.length ? { NOT: { org: { is: { vertical: { in: others } } } } } : {};
}

/** The world of an organization; a missing one is the default world (verticalFor's own rule). */
export async function worldOfOrg(orgId: string | null | undefined): Promise<VerticalKey> {
  return orgId ? verticalFor(orgId) : DEFAULT_VERTICAL;
}

/**
 * This person's account in this world, or null.
 *
 * `select` is REQUIRED, not optional: sign-in and password reset must not
 * hydrate a whole User row (its Json columns can throw — #1150,
 * scripts/check-auth-reads.mjs), and a helper that defaulted to the full row
 * would make the safe form the one you have to remember.
 */
export async function findUserInWorld<S extends Prisma.UserSelect>(
  email: string,
  world: VerticalKey,
  select: S,
): Promise<Prisma.UserGetPayload<{ select: S }> | null> {
  return prisma.user.findFirst({
    where: { email: normalizeEmail(email), ...worldUserWhere(world) },
    select,
    orderBy: { createdAt: 'asc' },
  }) as Promise<Prisma.UserGetPayload<{ select: S }> | null>;
}

/**
 * Every account of this world for this address. Normally zero or one; more
 * than one means two organizations of the SAME product hold the address (the
 * app never creates that — `emailTakenInWorld` — but an admin moving an
 * organization's vertical can), and the caller must not guess between them.
 */
export async function findUsersInWorld<S extends Prisma.UserSelect>(
  email: string,
  world: VerticalKey,
  select: S,
): Promise<Prisma.UserGetPayload<{ select: S }>[]> {
  return prisma.user.findMany({
    where: { email: normalizeEmail(email), ...worldUserWhere(world) },
    select,
    orderBy: { createdAt: 'asc' },
  }) as Promise<Prisma.UserGetPayload<{ select: S }>[]>;
}

/**
 * Every account this address holds, in ANY world. Only for callers whose whole
 * job is to cross worlds: the sign-in's WRONG_WORLD_* password check (the page
 * never names or links the other product), and account erasure. Anything that
 * acts on a person's behalf in
 * one product must use `findUserInWorld`.
 */
export async function findUsersByEmail<S extends Prisma.UserSelect>(
  email: string,
  select: S,
): Promise<Prisma.UserGetPayload<{ select: S }>[]> {
  return prisma.user.findMany({
    where: { email: normalizeEmail(email) },
    select,
    orderBy: { createdAt: 'asc' },
  }) as Promise<Prisma.UserGetPayload<{ select: S }>[]>;
}

/**
 * Does this world already have an account for this address? The check every
 * create path makes before inserting: "an account with this email already
 * exists" means IN THIS PRODUCT. The database's own (email, orgId) unique only
 * covers two rows in one organization, and not even that while `orgId` is
 * still NULL.
 */
export async function emailTakenInWorld(email: string, world: VerticalKey): Promise<boolean> {
  const row = await findUserInWorld(email, world, { id: true });
  return row !== null;
}

/** Same check, when the caller knows the ORGANIZATION the account is about to be created in. */
export async function emailTakenInOrgWorld(email: string, orgId: string | null | undefined): Promise<boolean> {
  return emailTakenInWorld(email, await worldOfOrg(orgId));
}
