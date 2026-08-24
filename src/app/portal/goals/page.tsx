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

export default async function PortalGoalsPage() {
  const session = await getServerSession(authOptions);
  // The layout gates unauthenticated users, but the session can be revoked
  // between the layout check and this render (e.g. "sign out of all devices"),
  // in which case session is null here — redirect instead of crashing.
  if (!session?.user?.id) redirect('/auth/signin');
  const { t } = await getServerDictionary();

  const [user, activeRelation] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { targetPosition: true },
    }),
    prisma.mentorshipRelation.findFirst({
      where: { menteeId: session.user.id, status: 'ACTIVE' },
      select: { id: true },
    }),
  ]);

  return (
    <div>
      <PortalTabs />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.portal.tabs.goals}</h1>
        <p className="text-gray-500 mt-1">{t.portal.goalsSubtitle}</p>
      </div>

      {activeRelation ? (
        <div className="space-y-6">
          <GoalsPanel relationId={activeRelation.id} />
          <EvaluationPanel relationId={activeRelation.id} audience="MENTOR" />
          <WeeklyReportsPanel relationId={activeRelation.id} mode="mentee" />
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
