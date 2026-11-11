// Per-user guidance state (#2068) — the acknowledgement half of in-product
// guidance: "I have seen this", "I dismissed this". Server-only (touches the DB).
//
// Deliberately narrow: this module never records PROGRESS. Whether a checklist
// step is done is derived from the rows that prove it (an invitation sent, a
// company added, a mentorship assigned), because a stored "I clicked it" flag
// can disagree with reality and a derived one cannot. Only the dismissal — a
// statement about the person, not about the data — is persisted.

import { prisma } from './prisma';

// The guidance key for a role's first-run checklist. Per role, mirroring the
// pre-server localStorage key (`onboarding-dismissed-<ROLE>`), so an admin and
// a mentor account do not share one dismissal.
export function checklistGuidanceKey(role: string): string {
  return `checklist:${role}`;
}

// Has this user dismissed the surface? The row is per (user, key), so the
// answer travels with the account rather than with the browser.
export async function isGuidanceDismissed(userId: string, key: string): Promise<boolean> {
  const row = await prisma.userGuidanceState.findUnique({
    where: { userId_key: { userId, key } },
    select: { dismissedAt: true },
  });
  return !!row?.dismissedAt;
}

// Record (or clear) a dismissal for ONE user. The caller passes the session
// user's id — there is no code path that takes it from a request body.
export async function setGuidanceDismissed(
  userId: string,
  key: string,
  dismissed: boolean
): Promise<void> {
  const dismissedAt = dismissed ? new Date() : null;
  await prisma.userGuidanceState.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, dismissedAt, seenAt: new Date() },
    update: { dismissedAt },
  });
}

// ── Tours (#2067, src/lib/tours.ts) ──────────────────────────────────────────
// The same table, keyed `tour:<id>`. `seenAt` = finished, `dismissedAt` =
// skipped; either one means the tour is not offered again.

export type TourState = 'new' | 'completed' | 'dismissed';

/** The state of each of `keys` for ONE user (the session's — callers never take it from a request). */
export async function readTourStates(userId: string, keys: string[]): Promise<Record<string, TourState>> {
  const rows = keys.length
    ? await prisma.userGuidanceState.findMany({
        where: { userId, key: { in: keys } },
        select: { key: true, seenAt: true, dismissedAt: true },
      })
    : [];
  const out: Record<string, TourState> = Object.fromEntries(keys.map((k) => [k, 'new' as TourState]));
  for (const r of rows) out[r.key] = r.dismissedAt ? 'dismissed' : r.seenAt ? 'completed' : 'new';
  return out;
}

/** Record that ONE user finished or skipped a tour. Idempotent: a rerun only moves the timestamp. */
export async function recordTourOutcome(userId: string, key: string, outcome: 'completed' | 'dismissed'): Promise<void> {
  const now = new Date();
  const data = outcome === 'completed' ? { seenAt: now, dismissedAt: null } : { dismissedAt: now };
  await prisma.userGuidanceState.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, ...data },
    update: data,
  });
}
