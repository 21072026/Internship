import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { seal } from '@/lib/secretBox';
import { assertPublicHttpsUrl, SsrfBlockedError } from '@/lib/ssrfGuard';
import {
  ROSTER_FEED_LIMITS,
  ROSTER_FEED_SECRET_PURPOSE,
  validateFeedConfig,
  type RosterFeedError,
  type RosterFeedInput,
} from '@/lib/rosterFeed';

// The admin side of a roster feed's configuration (#1964): what
// /api/admin/roster-feeds reads and writes. The rules are in rosterFeed.ts;
// this file is where they meet the row and the sealed secret.
//
// THE SECRET. Written once through `seal(…, 'roster-feed-secret')` and never
// selected again by anything here: `PUBLIC_FEED_SELECT` does not name
// `secretEnc`, and the answer carries `secretSet: boolean` instead — the
// `ssoCertificateSet` pattern. The only reader of the sealed value is the run
// (`resolveFeedSecret` in rosterIngestStore.ts). It never goes into an
// ActivityLog detail, an error message or a log line.

/** Every column an admin may read back. `secretEnc` is deliberately absent. */
export const PUBLIC_FEED_SELECT = {
  id: true,
  name: true,
  transport: true,
  enabled: true,
  url: true,
  sftpHost: true,
  sftpPort: true,
  sftpUsername: true,
  sftpPath: true,
  sftpHostKeyFingerprint: true,
  credentialEnvVar: true,
  delimiter: true,
  keyField: true,
  columnMap: true,
  authoritative: true,
  chunkSize: true,
  cronExpression: true,
  deprovision: true,
  maxDeactivatePercent: true,
  minRowCount: true,
  deprovisionGraceDays: true,
  lastRunAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RosterFeedSelect;

type PublicFeedRow = Prisma.RosterFeedGetPayload<{ select: typeof PUBLIC_FEED_SELECT }>;

export type PublicRosterFeed = PublicFeedRow & { secretSet: boolean };

/** Load this org's feed for the admin, or null — another org's id reads as absent. */
export async function loadPublicFeed(id: string, orgId: string): Promise<PublicRosterFeed | null> {
  const row = await prisma.rosterFeed.findFirst({
    where: { id, orgId },
    select: { ...PUBLIC_FEED_SELECT, secretEnc: true },
  });
  return row ? toPublicFeed(row) : null;
}

export async function listPublicFeeds(orgId: string): Promise<PublicRosterFeed[]> {
  const rows = await prisma.rosterFeed.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: { ...PUBLIC_FEED_SELECT, secretEnc: true },
  });
  return rows.map(toPublicFeed);
}

function toPublicFeed(row: PublicFeedRow & { secretEnc: string | null }): PublicRosterFeed {
  const { secretEnc, ...rest } = row;
  return { ...rest, secretSet: Boolean(secretEnc) };
}

export type FeedWriteResult =
  | { ok: true; value: RosterFeedInput; secretEnc: string | null | undefined }
  | { ok: false; errors: RosterFeedError[] };

/**
 * Validate a create (no `current`) or an edit (merged over `current`), and work
 * out what happens to the secret: `undefined` = leave it, `null` = clear it, a
 * string = the new sealed value. An edit re-validates the WHOLE merged config,
 * so a PATCH that switches the transport cannot leave the other one's
 * requirements unchecked.
 *
 * The URL is checked against the SSRF guard here as well as before every
 * fetch: a feed that can never be fetched should not save.
 */
export async function prepareFeedWrite(
  body: Record<string, unknown>,
  current?: Record<string, unknown>,
): Promise<FeedWriteResult> {
  const merged = { ...(current ?? {}), ...body };
  const checked = validateFeedConfig(merged);
  if (!checked.ok) return checked;

  const errors: RosterFeedError[] = [];
  let secretEnc: string | null | undefined;
  if (body.clearSecret === true) secretEnc = null;
  if (typeof body.secret === 'string' && body.secret.length > 0) {
    if (body.secret.length > ROSTER_FEED_LIMITS.secret) errors.push({ field: 'secret', code: 'too_long' });
    else secretEnc = seal(body.secret, ROSTER_FEED_SECRET_PURPOSE);
  }

  if (checked.value.transport === 'HTTPS' && checked.value.url) {
    try {
      await assertPublicHttpsUrl(checked.value.url);
    } catch (e) {
      if (!(e instanceof SsrfBlockedError)) throw e;
      errors.push({ field: 'url', code: 'blocked' });
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: checked.value, secretEnc };
}

/** The validated config as a Prisma write. */
export function feedWriteData(value: RosterFeedInput, secretEnc: string | null | undefined) {
  return {
    ...value,
    columnMap: value.columnMap as Prisma.InputJsonValue,
    ...(secretEnc !== undefined ? { secretEnc } : {}),
  };
}
