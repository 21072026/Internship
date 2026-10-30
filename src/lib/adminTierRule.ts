// Admin tier & scope assignment (#1579) — the rules, pure and dependency-free
// (scripts/test/admin-tier-rule.test.mjs). WHO may assign at all is the
// permission `admin.grant` in src/lib/authzRule.ts, asked through
// requirePermission() like every other admin action — this file adds no second
// authorization path, only the facts about a CHANGE that a permission cannot
// see: whose tier it is, what it becomes, and who would be left.
//
// THE GUARDS, all enforced server-side by src/lib/adminTiers.ts:
//   1. No self-change. An actor never changes their own tier — not up (no
//      self-elevation) and not down (a slip that locks them out of the very
//      screen that would undo it). Another ORG_ADMIN does it.
//   2. Never above one's own tier, and never on someone above it. With
//      `admin.grant` held by ORG_ADMIN only this is unreachable today; it is
//      kept as the rule so a later narrower tier holding the permission cannot
//      mint an ORG_ADMIN.
//   3. The last ORG_ADMIN stays. An organization must keep at least one ACTIVE
//      ORG_ADMIN: demoting, deactivating or deleting the last one is refused.
//      This is the existing last-admin guard one tier up — every path that can
//      remove an org admin asks `wouldRemoveLastOrgAdmin()`.
//   (There is no SUPER_ADMIN tier: the platform operator is the per-world
//   `isSuperAdmin` flag, set only by prisma/set-super-admin.mjs, #2647.)
//   4. Scope grants mean something only for PROGRAM_ADMIN, and name a cohort
//      or a company of the SAME org — never both empty.

import { ADMIN_TIERS, adminTierFor, type AdminTier } from './authzRule';

/** Higher is broader. */
export const TIER_RANK: Readonly<Record<AdminTier, number>> = Object.freeze({ OBSERVER: 1, PROGRAM_ADMIN: 2, ORG_ADMIN: 3 });

export function isAdminTier(v: unknown): v is AdminTier {
  return typeof v === 'string' && (ADMIN_TIERS as readonly string[]).includes(v);
}

export type TierRefusal = 'self_change' | 'not_admin' | 'above_own' | 'target_above_own' | 'last_org_admin';

export interface TierChange {
  actorId: string;
  /** The actor's effective tier (adminTierFor). */
  actorTier: AdminTier | null;
  targetId: string;
  targetRole: string;
  /** The target's raw column; null on an ADMIN reads as ORG_ADMIN. */
  targetLevel: string | null;
  next: AdminTier;
  /** ACTIVE ORG_ADMINs of the target's org other than the target. */
  otherActiveOrgAdmins: number;
}

/** Null when the change may happen, else the one reason it may not. */
export function tierChangeRefusal(c: TierChange): TierRefusal | null {
  if (c.actorId === c.targetId) return 'self_change';
  const current = adminTierFor(c.targetRole, c.targetLevel);
  if (!current) return 'not_admin';
  const actorRank = c.actorTier ? TIER_RANK[c.actorTier] : 0;
  if (TIER_RANK[c.next] > actorRank) return 'above_own';
  if (TIER_RANK[current] > actorRank) return 'target_above_own';
  if (wouldRemoveLastOrgAdmin(current, c.next, c.otherActiveOrgAdmins)) return 'last_org_admin';
  return null;
}

/**
 * Would this take the org's last active ORG_ADMIN away? `next` null means the
 * account stops being one at all (deactivated, deleted, role changed).
 */
export function wouldRemoveLastOrgAdmin(current: AdminTier | null, next: AdminTier | null, otherActiveOrgAdmins: number): boolean {
  return current === 'ORG_ADMIN' && next !== 'ORG_ADMIN' && otherActiveOrgAdmins < 1;
}

export type GrantRefusal = 'not_program_admin' | 'empty_grant';

/** A scope grant may be added only to a PROGRAM_ADMIN and must name something. */
export function grantRefusal(targetTier: AdminTier | null, grant: { cohortId?: string | null; companyId?: string | null }): GrantRefusal | null {
  if (targetTier !== 'PROGRAM_ADMIN') return 'not_program_admin';
  if (!grant.cohortId && !grant.companyId) return 'empty_grant';
  return null;
}
