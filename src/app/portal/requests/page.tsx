import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { getServerDictionary } from '@/i18n/server';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { PortalTabs } from '@/components/PortalTabs';
import { QuestionsPanel } from '@/components/QuestionsPanel';
import { MeetingRequestsPanel } from '@/components/MeetingRequestsPanel';
import { Card } from '@/components/ui/Card';

export default async function PortalRequestsPage() {
  const session = await getServerSession(authOptions);
  // The layout gates unauthenticated users, but the session can be revoked
  // between the layout check and this render (e.g. "sign out of all devices"),
  // in which case session is null here — redirect instead of crashing.
  if (!session?.user?.id) redirect('/auth/signin');
  const { t } = await getServerDictionary();

  const activeRelation = await prisma.mentorshipRelation.findFirst({
    where: { menteeId: session.user.id, status: 'ACTIVE' },
    select: {
      id: true,
      // `timezone` (#1210): the meeting-request form shows a proposed slot on
      // the mentor's clock as well as the mentee's before it is sent.
      // `id` (#1361): the request form reads the mentor's posted availability
      // and offers those hours as concrete choices.
      mentor: { select: { id: true, fullName: true, timezone: true } },
    },
  });

  return (
    <div>
      <PortalTabs />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.portal.tabs.requests}</h1>
        <p className="text-gray-500 mt-1">{t.portal.requestsSubtitle}</p>
      </div>

      {activeRelation ? (
        <div className="space-y-6">
          <QuestionsPanel relationId={activeRelation.id} mode="ask" />
          <MeetingRequestsPanel
            relationId={activeRelation.id}
            mode="request"
            counterpart={{
              id: activeRelation.mentor.id,
              name: activeRelation.mentor.fullName,
              timezone: activeRelation.mentor.timezone,
            }}
          />
        </div>
      ) : (
        <Card>
          <p className="text-sm text-gray-500">{t.portal.noRelationSection}</p>
        </Card>
      )}
    </div>
  );
}
