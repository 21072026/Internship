// Reading a tenant's vertical (#2350, epic #2348).
//
// THE CONTRACT, stated once:
//
//   A vertical is ALWAYS read for an explicit orgId. It is never put in the
//   JWT and never inferred from the session alone.
//
// Two reasons, both learned from things already in this repo:
//
//   1. `role` IS in the JWT (src/lib/auth.ts), and that is precisely why the
//      schema's SUPER_ADMIN note gives changing it as the example of an
//      expensive move: a value copied into a token is a value that keeps being
//      true in open sessions long after the row changed. A tenant's product
//      must change the moment an admin changes it, not at next sign-in.
//
//   2. Most of the surface that will eventually need a vertical does NOT run
//      inside a request — the cron sweeps, the newsletter fan-out, the webhook
//      dispatcher. There is no session to read there. Making orgId a required
//      argument means those callers are forced to answer "on behalf of which
//      tenant?" instead of silently picking whatever the ambient context had.
//
// So: a code path that cannot produce an orgId is not vertical-aware, and it
// stays on the default. That is a deliberate boundary, not an oversight — the
// work of making the out-of-request surface org-aware is #2357.

import { prisma } from '@/lib/prisma';
import { DEFAULT_VERTICAL, toVerticalKey, type VerticalKey } from '@/lib/verticals';

// The vertical of one organization. A missing org (deleted, or an id from a
// stale link) reads as the default rather than throwing: the caller is asking
// "which product is this?", and the honest answer for a row that is not there
// is the product this instance already was.
export async function verticalFor(orgId: string): Promise<VerticalKey> {
  if (!orgId) return DEFAULT_VERTICAL;
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { vertical: true },
  });
  return toVerticalKey(org?.vertical);
}

// Batch form for list screens: one query for many orgs instead of N.
// Unknown ids are simply absent from the map; callers use toVerticalKey/the
// default for anything they do not find.
export async function verticalsFor(orgIds: string[]): Promise<Map<string, VerticalKey>> {
  const ids = [...new Set(orgIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await prisma.organization.findMany({
    where: { id: { in: ids } },
    select: { id: true, vertical: true },
  });
  return new Map(rows.map((r) => [r.id, toVerticalKey(r.vertical)]));
}
