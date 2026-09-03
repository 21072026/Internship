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
