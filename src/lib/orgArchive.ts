// Is a tenant archived (#1582, docs/tenant-lifecycle.md)? The mail gate's read,
// in its own tiny module so emailService does not import the lifecycle writer
// (and through it the event bus) just to ask one question. Server-only.
//
// A mail path can fan out over hundreds of recipients of one org; a 30 s memo
// keeps that to one read per org. The writer (src/lib/orgLifecycle.ts) clears
// the entry at once in its own process; another replica sees the change
// within the TTL. Sign-in does NOT use this cache — src/lib/auth.ts reads the
// row fresh on every door.

import { prisma } from '@/lib/prisma';

const ARCHIVE_TTL_MS = 30_000;
const memo = new Map<string, { archived: boolean; at: number }>();

export async function isOrgArchived(orgId: string | null | undefined): Promise<boolean> {
  if (!orgId) return false;
  const hit = memo.get(orgId);
  if (hit && Date.now() - hit.at < ARCHIVE_TTL_MS) return hit.archived;
  try {
    const row = await prisma.organization.findUnique({ where: { id: orgId }, select: { archivedAt: true } });
    const archived = Boolean(row?.archivedAt);
    memo.set(orgId, { archived, at: Date.now() });
    return archived;
  } catch {
    // Fail OPEN, like the opt-out read: an unreadable flag must not swallow a
    // password reset for a live tenant.
    return false;
  }
}

export function forgetOrgArchive(orgId: string): void {
  memo.delete(orgId);
}
