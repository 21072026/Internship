import { getServerSession } from 'next-auth';
import { notFound, redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import { salesTeamReadAllowed } from '@/lib/salesBook';
import { SalesCalendarClient } from './SalesCalendarClient';

// The sales rep's calendar (#3778): their meetings, their records' follow-up
// days and trial ends — and, where the shared team-read rule allows it, a
// read-only "Team" view of their colleagues'. The shell (src/app/sales/layout.tsx)
// is the first door; this page re-checks the surface, like the other /sales
// pages, and asks the team rule once so the toggle is only offered to a viewer
// it lets in. Both APIs ask their own gates again.
export default async function SalesCalendarPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/auth/signin');
  if (!hasSalesSurface(session.user.role, await shellCapabilities(session.user.orgId))) notFound();
  return <SalesCalendarClient teamAllowed={await salesTeamReadAllowed(session)} />;
}
