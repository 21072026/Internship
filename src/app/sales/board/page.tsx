import { getServerSession } from 'next-auth';
import { notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { MentorBoard } from '@/components/board/MentorBoard';
import { salesTeamReadAllowed } from '@/lib/salesBook';
import { actorFromSession, can, dispatcherMay } from '@/lib/authz';
import { tenantWhere } from '@/lib/tenantFilter';
import { AssignedToYouCard } from '@/components/sales/AssignedToYouCard';

// The rep's board (#2580): the mentor board over the viewer's own sales book
// (GET /api/mentorship?surface=sales, src/lib/salesBookRule.ts — an ADMIN's too;
// the dispatcher's is the tenant's), whose moves only the owner may write — a
// card opens the sales lead page, which reads the same rule.
//
// The team view ("Team", `?view=team`) reads the org's book read-only
// (GET /api/sales/team-book) and is offered only to a viewer the team read
// allows. Who may move which card is decided here, on the server, from the
// same facts the write routes check: the owner always; the dispatcher (not
// under impersonation) and an admin with relation.write any card of the org.
export default async function SalesBoardPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) notFound();
  const [teamRead, actor, tenant] = await Promise.all([salesTeamReadAllowed(session), actorFromSession(session), tenantWhere(session)]);
  const writeAll =
    !!actor &&
    (dispatcherMay(actor, 'relation.write', session.user.orgId ?? null) || (await can(actor, 'relation.write', undefined, session)));
  return (
    <>
      {/* New on the rep's list (#3874): one line above the columns, each name a link. */}
      <AssignedToYouCard viewerId={session.user.id} tenant={tenant} impersonating={!!session.user.impersonatorId} variant="strip" />
      <MentorBoard
        detailBase="/sales/leads"
        handoff
        surface="sales"
        viewer={{ id: session.user.id, writeAll, teamRead }}
      />
    </>
  );
}
