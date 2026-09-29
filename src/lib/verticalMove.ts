// Moving an organization to the other product (worlds, #2590).
//
// An organization's `vertical` IS the world its people live in (userWorld.ts:
// a world is derived from the org, never stored on the user). So changing it
// does not touch one row — it MOVES every account of the organization into the
// other world at once, in a single UPDATE.
//
// That is harmless until a person already holds an account over there. One
// person, one e-mail, two worlds is the designed state — but only ONE account
// per (e-mail, world). If the organization being moved holds `ada@x.com` and
// the destination world already has an `ada@x.com` of its own, the move would
// silently create the state the whole model forbids: two accounts of the same
// address in the same product. Sign-in would then have to guess between them
// (auth.ts `pickAccount` falls back to the password), password reset and the
// unsubscribe/lockout flows would act on an ambiguous pair, and — worst — the
// two people-who-are-really-one would land in the same product without either
// of them, or the operator, ever having decided to merge them.
//
// The database cannot catch it: `@@unique([email, orgId])` covers only two rows
// in ONE organization, and these live in two. So the PATCH that flips the
// vertical asks this module first and refuses when the answer is not zero.
//
// WHAT THE REFUSAL SAYS. A count and nothing else. The route's caller is a
// super admin, but the addresses belong to people in two different tenants, and
// "which of my users collide with which of theirs" is exactly the cross-tenant
// disclosure the tenant model exists to prevent. The count is enough to know the
// move is blocked; resolving it (renaming one address, or erasing a stale
// duplicate) is done per tenant, by that tenant's own admin, who can see their
// own rows.
//
// A move that IS allowed also does two things worth knowing about, neither of
// which needs code here: every open session of the organization's people stops
// working on the old world's host at once (the session callback in auth.ts
// recomputes the world mismatch from the org's CURRENT vertical on every
// request), so they sign in again on the new world's host; and remembered
// devices/links minted for the old host are declined by the same rule until then
// (api/auth/remember/refresh).
//
// SERVER-ONLY (Prisma).

import { prisma } from '@/lib/prisma';
import { runUnscoped } from '@/lib/tenantAmbient';
import { worldUserWhere } from '@/lib/userWorld';
import { toVerticalKey, type VerticalKey } from '@/lib/verticals';

/** Stable code the admin screen and API clients switch on. */
export const VERTICAL_MOVE_EMAIL_CONFLICT = 'vertical_move_email_conflict';

// Page size of the scan over the moving organization's users. The `IN` list of a
// page is what the second query sends, so this also bounds that statement.
const PAGE = 500;

/**
 * How many accounts already in the `to` world share an e-mail address with one
 * of the organization's users — i.e. how many same-world duplicates moving the
 * organization to `to` would create. Zero means the move is safe.
 *
 * A move that keeps the organization in the world it is already in (an
 * unregistered legacy key reads as the default world, `toVerticalKey`) changes
 * nobody's world and is always zero.
 *
 * Runs outside the tenant filter on purpose: the whole question is about the
 * OTHER tenants' rows, which a bound request scope would hide.
 */
export async function countVerticalMoveConflicts(orgId: string, from: unknown, to: VerticalKey): Promise<number> {
  if (toVerticalKey(from) === to) return 0;
  return runUnscoped(async () => {
    let conflicts = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await prisma.user.findMany({
        where: { orgId },
        select: { id: true, email: true },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;
      // The moving organization's own users are in the OLD world, so the
      // destination-world filter excludes them by itself — no self-match.
      conflicts += await prisma.user.count({
        where: { email: { in: page.map((u) => u.email) }, ...worldUserWhere(to) },
      });
      if (page.length < PAGE) break;
    }
    return conflicts;
  });
}
