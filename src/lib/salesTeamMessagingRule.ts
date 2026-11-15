// Team messaging on the sales surface: who of a sales team may write to whom,
// and who may open the team's one room.
//
// THE RULE. Two people of the SAME organisation, both of them sales staff
// (src/lib/salesSurface.ts: a MENTOR or ADMIN of a vertical with the sales
// surface), both active, may message each other directly. The org's team room
// opens for exactly that set, read live on every request, so a new rep sees it
// at once and a deactivated one loses it at once.
//
// What it does NOT open:
//   - a lead (MENTEE) or a customer login (COMPANY): neither is sales staff;
//   - another organisation: same-org is required, there is no exception;
//   - an INTERNSHIP org: its vertical carries `mentorship`, so nobody there
//     has the sales surface and canMessage() answers exactly as before.
//
// Pure and dependency-free (type imports only), so the unit runner loads it.

import type { VerticalCapability } from '@/lib/verticals';
import { hasSalesSurface } from '@/lib/salesSurface';

export interface MessagingParty {
  id: string;
  role: string;
  orgId: string | null;
  isActive: boolean;
}

/** Is this person sales staff of `orgId` right now? */
export function isSalesStaffOf(
  person: MessagingParty | null | undefined,
  orgId: string | null | undefined,
  capabilities: readonly VerticalCapability[],
): boolean {
  if (!person || !orgId || person.orgId !== orgId || !person.isActive) return false;
  return hasSalesSurface(person.role, capabilities);
}

/**
 * May these two write to each other as colleagues? `capabilities` is the
 * capability set of their (shared) organisation's vertical.
 */
export function salesColleaguesMayMessage(
  a: MessagingParty | null | undefined,
  b: MessagingParty | null | undefined,
  capabilities: readonly VerticalCapability[],
): boolean {
  if (!a || !b || a.id === b.id) return false;
  if (!a.orgId || a.orgId !== b.orgId) return false;
  return isSalesStaffOf(a, a.orgId, capabilities) && isSalesStaffOf(b, a.orgId, capabilities);
}

/**
 * The team room's identity: one per organisation, carried in the unique
 * `Conversation.teamKey` column, so two first visits at once cannot create
 * two rooms.
 */
const TEAM_KEY_PREFIX = 'sales-team:';

export function salesTeamKey(orgId: string): string {
  return `${TEAM_KEY_PREFIX}${orgId}`;
}

/** The organisation a team key belongs to; null for anything that is not one. */
export function orgOfSalesTeamKey(key: string | null | undefined): string | null {
  if (!key || !key.startsWith(TEAM_KEY_PREFIX)) return null;
  const orgId = key.slice(TEAM_KEY_PREFIX.length);
  return orgId.length > 0 ? orgId : null;
}
