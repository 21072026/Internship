import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { getServerDictionary } from '@/i18n/server';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { PortalTabs } from '@/components/PortalTabs';
import { QuestionsPanel } from '@/components/QuestionsPanel';
import { MeetingRequestsPanel } from '@/components/MeetingRequestsPanel';
import { Card } from '@/components/ui/Card';
import { ArchivedNotice } from '@/components/ArchivedNotice';
import { menteeRelationWhere, pickMenteeRelation } from '@/lib/menteeRelation';

export default async function PortalRequestsPage() {
  const session = await getServerSession(authOptions);
  // The layout gates unauthenticated users, but the session can be revoked
  // between the layout check and this render (e.g. "sign out of all devices"),
  // in which case session is null here — redirect instead of crashing.
  if (!session?.user?.id) redirect('/auth/signin');
  const { t } = await getServerDictionary();

  // ACTIVE, else the latest COMPLETED one shown read-only (#1408).
  const relations = await prisma.mentorshipRelation.findMany({
    where: menteeRelationWhere(session.user.id),
    select: {
      id: true,
      status: true,
      startDate: true,
      completedAt: true,
      // `timezone` (#1210): the meeting-request form shows a proposed slot on
      // the mentor's clock as well as the mentee's before it is sent.
      mentor: { select: { fullName: true, timezone: true } },
    },
  });
  const { relation, isArchived } = pickMenteeRelation(relations);

  return (
    <div>
      <PortalTabs />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.portal.tabs.requests}</h1>
        {/* "Ask your mentor a question or request a meeting" would contradict the
            archive notice below it, where both are closed. */}
        {!isArchived && <p className="text-gray-500 mt-1">{t.portal.requestsSubtitle}</p>}
      </div>

      {relation ? (
        <div className="space-y-6">
          {isArchived && <ArchivedNotice title={t.portal.archived.title} hint={t.portal.archived.hint} />}
          <QuestionsPanel relationId={relation.id} mode="ask" readOnly={isArchived} />
          <MeetingRequestsPanel
            relationId={relation.id}
            mode="request"
            readOnly={isArchived}
            counterpart={{ name: relation.mentor.fullName, timezone: relation.mentor.timezone }}
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
