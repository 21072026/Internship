// The server half of src/lib/salesBookRule.ts: whose sales book a session
// sees. Read LIVE (the dispatcher flag is, src/lib/salesDispatcher.ts).
// Server-only.
import type { Session } from 'next-auth';
import { isSalesDispatcher } from '@/lib/salesDispatcher';
import { canReadSalesTeamBook, parseSalesTeamBookSetting, salesBookWhere, salesBookWriteAllowed, type SalesBookWhere } from '@/lib/salesBookRule';
import { actorFromSession, can, dispatcherMay } from '@/lib/authz';
import { relationSubject } from '@/lib/authzRule';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { settingsOrgOf } from '@/lib/settingsOrg';

export async function salesBookScope(session: Session): Promise<SalesBookWhere> {
  return salesBookWhere({ userId: session.user.id, dispatcher: await isSalesDispatcher(session.user.id) });
}

/**
 * May this session READ the org's whole sales book (the team view)? The sales
 * surface first (a vertical with `pipeline` and without `mentorship`, ADMIN or
 * MENTOR), then the rule. Read-only: nothing that writes may ask this.
 */
export async function salesTeamReadAllowed(session: Session): Promise<boolean> {
  if (!session?.user?.id) return false;
  const capabilities = await shellCapabilities(session.user.orgId);
  if (!hasSalesSurface(session.user.role, capabilities)) return false;
  const [raw, dispatcher] = await Promise.all([
    resolveSettingRaw('salesTeamBookForReps', { orgId: await settingsOrgOf(session) }),
    isSalesDispatcher(session.user.id),
  ]);
  return canReadSalesTeamBook({ teamSetting: parseSalesTeamBookSetting(raw), role: session.user.role, dispatcher });
}

/** May `session` work (write) this record? The write half of the rule, from the data. */
export async function canWriteSalesRecord(
  session: Session,
  relation: { orgId: string | null; mentorId: string; cohortId?: string | null; companyId?: string | null },
): Promise<boolean> {
  if (relation.mentorId === session.user.id) return true;
  const actor = await actorFromSession(session);
  if (!actor) return false;
  return salesBookWriteAllowed({
    userId: session.user.id,
    ownerId: relation.mentorId,
    dispatcher: dispatcherMay(actor, 'relation.write', relation.orgId),
    adminWrite: await can(actor, 'relation.write', relationSubject(relation), session),
  });
}
