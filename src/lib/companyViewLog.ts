import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import type { HeaderSource } from '@/lib/clientIp';

/**
 * "Who read this customer record?" (#2433)
 *
 * NO NEW TABLE, NO SECOND LOG PATH. The inherited backlog asked for an
 * `AccessLog` model; everything it wanted already exists here:
 *   - the row      → `ActivityLog` (actorId, targetType, targetId, ip, userAgent)
 *   - the promise  → `logActivity()` swallows its own insert error, so a read
 *                    still answers when the audit write fails (src/lib/activity.ts)
 *   - the lifetime → the `activityLog` entry in src/lib/retentionEntries.ts,
 *                    window `activityLogRetentionDays` (365 by default).
 * `company.view` is deliberately NOT in `RETAINED_ACTIVITY_ACTIONS`, so it is
 * pruned whole with everything else rather than kept forever as evidence.
 */
export const COMPANY_VIEW_ACTION = 'company.view';

/**
 * How long one reader's repeat views of the SAME company collapse into a single
 * audit row.
 *
 * A named constant rather than a `Setting`: every key in `SETTING_DEFAULTS` is
 * something an organisation has an opinion about (retention promises, cadences,
 * quotas, caps), and none of them is a log-noise threshold. This number changes
 * what the ledger COSTS, not what it promises — the promise is "a read of a
 * customer record is attributable", and one row per reader per sitting keeps it.
 *
 * 30 minutes ≈ one working sitting. The question the ledger answers is "did X
 * open this account", never "how many times did the client refetch": a detail
 * read happens again on every render, every tab restore and every back
 * navigation, so an unsuppressed write turns a table kept for 365 days into one
 * nobody can read.
 */
export const COMPANY_VIEW_LOG_WINDOW_MS = 30 * 60 * 1000;

export interface CompanyViewInput {
  companyId: string;
  /** Stored as `detail`, so an incident review can still name the account after the row is gone. */
  companyName?: string | null;
  actorId: string;
  actorEmail?: string | null;
  request?: HeaderSource | null;
}

/**
 * Record that `actorId` read company `companyId`, unless that reader already has
 * a row for that company inside `COMPANY_VIEW_LOG_WINDOW_MS`.
 *
 * Never throws — the same contract as `logActivity()` itself, and for the same
 * reason: the detail read must answer even when the audit trail cannot be
 * written. The de-dup READ is the new part, so it carries its own try/catch and
 * FALLS THROUGH to the write when it fails: a duplicate row is noise, a missing
 * one is a hole in the ledger.
 *
 * Two concurrent reads can both miss the window and both write. That is
 * accepted: the window is a volume control, not a uniqueness constraint, and
 * buying exactness would put a transaction or a lock in front of a GET.
 */
export async function logCompanyView(input: CompanyViewInput): Promise<void> {
  try {
    const recent = await prisma.activityLog.findFirst({
      where: {
        action: COMPANY_VIEW_ACTION,
        actorId: input.actorId,
        targetId: input.companyId,
        createdAt: { gte: new Date(Date.now() - COMPANY_VIEW_LOG_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (recent) return;
  } catch {
    // Deliberately empty — fall through and write the row.
  }

  await logActivity({
    action: COMPANY_VIEW_ACTION,
    actorId: input.actorId,
    actorEmail: input.actorEmail ?? null,
    targetType: 'Company',
    targetId: input.companyId,
    detail: input.companyName ?? null,
    request: input.request ?? null,
  });
}
