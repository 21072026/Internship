import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { getServerDictionary } from '@/i18n/server';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { PortalTabs } from '@/components/PortalTabs';
import { GoalsPanel } from '@/components/GoalsPanel';
import { EvaluationPanel } from '@/components/EvaluationPanel';
import { WeeklyReportsPanel } from '@/components/WeeklyReportsPanel';
import { InterviewPrep } from '@/components/InterviewPrep';
import { Card } from '@/components/ui/Card';
import { ArchivedNotice } from '@/components/ArchivedNotice';
import { menteeRelationWhere, pickMenteeRelation } from '@/lib/menteeRelation';

export default async function PortalGoalsPage() {
  const session = await getServerSession(authOptions);
  // The layout gates unauthenticated users, but the session can be revoked
  // between the layout check and this render (e.g. "sign out of all devices"),
  // in which case session is null here — redirect instead of crashing.
  if (!session?.user?.id) redirect('/auth/signin');
  const { t } = await getServerDictionary();

  const [user, relations] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { targetPosition: true },
    }),
    // ACTIVE, else the latest COMPLETED one shown read-only (#1408).
    prisma.mentorshipRelation.findMany({
      where: menteeRelationWhere(session.user.id),
      select: { id: true, status: true, startDate: true, completedAt: true },
    }),
  ]);
  const { relation, isArchived } = pickMenteeRelation(relations);

  return (
    <div>
      <PortalTabs />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.portal.tabs.goals}</h1>
        <p className="text-gray-500 mt-1">{t.portal.goalsSubtitle}</p>
      </div>

      {relation ? (
        <div className="space-y-6">
          {isArchived && <ArchivedNotice title={t.portal.archived.title} hint={t.portal.archived.hint} />}
          <GoalsPanel relationId={relation.id} readOnly={isArchived} />
          {/* Deliberately still writable on an archive: the feedback a mentee
              gives about their mentor is most likely to be written once the
              mentorship is over, and /api/evaluations accepts it. Only the
              actions that need a live mentorship are closed above and below. */}
          <EvaluationPanel relationId={relation.id} audience="MENTOR" />
          <WeeklyReportsPanel relationId={relation.id} mode="mentee" readOnly={isArchived} />
        </div>
      ) : (
        <Card>
          <p className="text-sm text-gray-500">{t.portal.noRelationSection}</p>
        </Card>
      )}

      {/* Works without a relation, as on the dashboard — always shown. */}
      <InterviewPrep defaultPosition={user?.targetPosition} />
    </div>
  );
}
