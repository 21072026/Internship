// Which tenant an ActivityLog entry belongs to (cross-world isolation).
//
// Dependency-free so it can be unit-tested and mirrored — the deploy backfill
// (prisma/backfill-activity-log-org.mjs) applies the SAME order to the rows
// written before `ActivityLog.orgId` existed, and scripts/test/
// activity-log-org.test.mjs pins the two together.
//
// THE ORDER
//   1. An explicit org from the call site. It knows best: a super admin acting
//      on another org, a public form whose org was decided from the host.
//   2. The actor's own org — the admin/mentor/mentee who did the thing. An
//      audit feed is "what happened in MY tenant", and the person acting is in
//      exactly one tenant (one User row per world, docs/worlds.md).
//   3. The target user's org, when the entry is ABOUT a user (a failed sign-in
//      against a known account, an unsubscribe click, a token redemption) and
//      nobody signed in did it.
//   4. Nothing. The row stays NULL — a system entry (a cron sweep, a deploy
//      step) — which the readers take as the default org's, by the rule in
//      src/lib/tenantFilter.ts. A NULL is never a wildcard.

/** targetType values that name a User row (both spellings are in the tree). */
export const USER_TARGET_TYPES: readonly string[] = ['user', 'User'];

export interface ActivityOrgFacts {
  explicitOrgId?: string | null;
  actorOrgId?: string | null;
  targetType?: string | null;
  targetUserOrgId?: string | null;
}

/** The org to stamp, or null when none of the sources resolves. */
export function pickActivityOrg(facts: ActivityOrgFacts): string | null {
  if (facts.explicitOrgId) return facts.explicitOrgId;
  if (facts.actorOrgId) return facts.actorOrgId;
  if (facts.targetType && USER_TARGET_TYPES.includes(facts.targetType) && facts.targetUserOrgId) {
    return facts.targetUserOrgId;
  }
  return null;
}
