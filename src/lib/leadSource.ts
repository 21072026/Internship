// The Prisma half of lead-source attribution (#2570): find or create a
// `Source` inside ONE tenant. The naming rule is src/lib/leadSourceName.ts.
//
// Every writer of a `Source` row goes through `findOrCreateSource()` — the two
// admin/picker routes, the marketing import's lead create and the demo-form
// conversion — so "which tenant does this row belong to" and "is this name
// already taken there" are answered once:
//
//   • The row is ALWAYS created with an explicit `orgId`. Before #2570 both
//     routes created it with none and relied on the (dormant) tenant middleware
//     to stamp one, so every source any tenant made landed in the default org
//     at the next deploy's backfill; that is why #2542 had to leave source
//     lookups unscoped. A sessionless caller passes the org it already decided.
//   • The lookup is `orgWhere(orgId)`: the default org also owns the legacy
//     `orgId IS NULL` rows. The unique index is `(orgId, name)` and MySQL does
//     not compare NULLs there, so without this pre-read the default org could
//     create "Google" next to a NULL-org "Google" — and the deploy backfill,
//     which stamps NULL → default, would then fail on the index.
//   • A concurrent create of the same name loses on the index (P2002) and
//     re-reads the winner, so two leads from the same new campaign get ONE row.
//     The index is case-insensitive under MySQL's default collation, which is
//     what `utm:Google` vs `utm:google` needs anyway.
//
// SERVER-ONLY (Prisma).

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { orgWhere, withinTenant } from '@/lib/tenantFilter';
import { leadSourceName, type LeadSourceInput } from '@/lib/leadSourceName';

export interface SourceRef {
  id: string;
  name: string;
}

export type FindOrCreateSourceResult = SourceRef & { created: boolean };

export async function findSourceByName(orgId: string, name: string): Promise<SourceRef | null> {
  return prisma.source.findFirst({
    where: withinTenant({ name }, await orgWhere(orgId)),
    // Oldest first: if a legacy NULL twin and a stamped row ever coexist, the
    // answer is stable.
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
}

/**
 * The tenant's Source called `name`, created (with `orgId` stamped) when there
 * is none. `extra` is only written on create — an existing row's contact
 * details are not the caller's to overwrite.
 */
export async function findOrCreateSource(
  orgId: string,
  name: string,
  extra: { contactName?: string | null; contactEmail?: string | null } = {},
): Promise<FindOrCreateSourceResult> {
  const existing = await findSourceByName(orgId, name);
  if (existing) return { ...existing, created: false };
  try {
    const row = await prisma.source.create({
      data: { orgId, name, contactName: extra.contactName ?? null, contactEmail: extra.contactEmail ?? null },
      select: { id: true, name: true },
    });
    return { ...row, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await findSourceByName(orgId, name);
      if (winner) return { ...winner, created: false };
    }
    throw error;
  }
}

/**
 * The `sourceId` a new lead of `orgId` gets from what it arrived with, or null
 * when nothing is known (the lead is then counted in the report's explicit
 * `unsourced` bucket — see leadSourceName.ts for why unknown is not a row).
 * The one function the web form and a machine ingest (#2450) call.
 */
export async function sourceIdForLead(orgId: string, input: LeadSourceInput): Promise<string | null> {
  const result = leadSourceName(input);
  if (result.kind === 'unknown') return null;
  return (await findOrCreateSource(orgId, result.name)).id;
}
