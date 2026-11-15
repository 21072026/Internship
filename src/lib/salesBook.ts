// The server half of src/lib/salesBookRule.ts: whose sales records a session
// reads, and whether it may work one. Read LIVE (the dispatcher flag and the
// admin permissions are). Server-only.
import type { Session } from 'next-auth';
import { isSalesDispatcher } from '@/lib/salesDispatcher';
import { actorFromSession, can, dispatcherMay } from '@/lib/authz';
import { relationSubject } from '@/lib/authzRule';
import { salesBookReadWhere, salesBookWriteAllowed, type SalesBookView, type SalesBookWhere } from '@/lib/salesBookRule';

export async function salesBookScope(session: Session, view: SalesBookView = 'mine'): Promise<SalesBookWhere> {
  return salesBookReadWhere({ userId: session.user.id, dispatcher: await isSalesDispatcher(session.user.id) }, view);
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
