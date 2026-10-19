// Erasing a person also silences the pull connector about them
// (docs/integrations/klaviyo.md § Erasure).
//
// A provider profile keeps describing the person after the CRM erased them, and
// the next sync would otherwise write them straight back: the gap-fill puts the
// name, address and line onto the scrubbed account again, or — the account's
// contact columns now being empty — a brand-new account is created for them.
// So the erasure turns every link of that person into a TOMBSTONE: the row stays
// with the provider's opaque profile id only, `erasedAt` is stamped, and the
// sync SKIPS that profile id from then on (src/lib/klaviyoSync.ts).
//
// A link is found by the lead it points at, or by `emailHash` — sha256 of the
// profile's lower-cased address, stored on a live link only, because a second
// person matched to an account by its name has no lead of their own and the
// account's contact columns name somebody else. The tombstone nulls the hash
// too (a hash of an address is the address again for anyone who can guess it,
// src/lib/companyContactErasure.ts), and nulls `companyId`, so deleting the
// account later cannot cascade the tombstone away and re-open the door.
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';

/** The lookup key of a profile's address on its link; null for no address. */
export function profileEmailHash(email: string | null | undefined): string | null {
  const v = (email ?? '').trim().toLowerCase();
  return v ? createHash('sha256').update(v).digest('hex') : null;
}

/** What a tombstone keeps: the provider's profile id and the erasure instant. */
export function externalProfileTombstoneData(at: Date) {
  return {
    erasedAt: at,
    companyId: null,
    leadUserId: null,
    emailHash: null,
    sourceName: null,
    consent: null,
    attributes: null,
    profileUpdatedAt: null,
  };
}

/**
 * The one write that tombstones a person's provider links inside ONE tenant —
 * by the lead's id and/or by the address. Returned unawaited so the erasure can
 * run it inside its own transaction.
 */
export function externalProfileErasureOp(input: {
  orgId: string;
  emails?: (string | null | undefined)[];
  leadUserId?: string | null;
  at?: Date;
}) {
  const hashes = [...new Set((input.emails ?? []).map(profileEmailHash).filter((h): h is string => Boolean(h)))];
  const or = [
    ...(input.leadUserId ? [{ leadUserId: input.leadUserId }] : []),
    ...(hashes.length ? [{ emailHash: { in: hashes } }] : []),
  ];
  return prisma.externalProfileLink.updateMany({
    // An empty OR would match nothing in Prisma; spelled out so it never widens.
    where: or.length ? { orgId: input.orgId, erasedAt: null, OR: or } : { id: '__none__' },
    data: externalProfileTombstoneData(input.at ?? new Date()),
  });
}
