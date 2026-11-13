// The sales dispatcher (#3656, docs/marketing-vertical/pipeline-record.md
// § The sales dispatcher). Server-only.
//
// A sales team lead who is NOT an org admin: an ORG_ADMIN marks a sales rep
// (MENTOR) as dispatcher, and from then on that rep may work the whole
// tenant's sales book — see every record, hand any lead to any rep, and manage
// another rep's records as their owner would (stage, follow-up, trial, value,
// interactions, contact). Nothing else: no people, settings or content.
//
// THE FLAG GRANTS NOTHING ON ITS OWN. It is effective only for an active MENTOR
// of an org whose vertical has the sales surface (`hasSalesSurface`) — on an
// INTERNSHIP mentor, an admin or a lead it is inert. That check lives HERE and
// nowhere else; `actorFromSession()` (src/lib/authz.ts) and the relation scope
// (src/lib/authzScope.ts) read it through `isSalesDispatcher()`. The powers
// themselves are one list in src/lib/authzRule.ts (SALES_DISPATCHER_PERMISSIONS),
// always on a named record of the dispatcher's own org.
//
// Read LIVE on every request: revoking the flag takes effect on the next
// request, with no session to revoke.
import 'server-only';
import { prisma } from '@/lib/prisma';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import type { VerticalCapability } from '@/lib/verticals';

/** The pure half: is a user with these facts an effective dispatcher? */
export function effectiveSalesDispatcher(input: {
  role: string;
  isActive: boolean;
  salesDispatcher: boolean;
  capabilities: readonly VerticalCapability[];
}): boolean {
  return input.salesDispatcher && input.isActive && input.role === 'MENTOR' && hasSalesSurface('MENTOR', input.capabilities);
}

/** Whether `userId` is an effective sales dispatcher right now. */
export async function isSalesDispatcher(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, isActive: true, salesDispatcher: true, orgId: true },
  });
  if (!user?.salesDispatcher || user.role !== 'MENTOR') return false;
  return effectiveSalesDispatcher({ ...user, capabilities: await shellCapabilities(user.orgId) });
}
