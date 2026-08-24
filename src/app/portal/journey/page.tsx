import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerDictionary } from '@/i18n/server';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { PortalTabs } from '@/components/PortalTabs';
import { JourneyTracker } from '@/components/JourneyTracker';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/Badge';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { User, Building2, BookOpen, ExternalLink, MessageCircle } from 'lucide-react';
import { formatDate } from '@/lib/relativeTime';

async function getActiveRelation(menteeId: string) {
  return prisma.mentorshipRelation.findFirst({
    where: { menteeId, status: 'ACTIVE' },
    include: {
      mentor: {
        // `timezone` (#1210): the meeting-request form shows a proposed slot on
        // the mentor's clock as well as the mentee's before it is sent.
        select: { id: true, fullName: true, email: true, department: true, phone: true, publicProfile: true, timezone: true },
      },
      company: true,
      interactions: {
        orderBy: { date: 'desc' },
        take: 5,
      },
    },
  });
}

export default async function PortalJourneyPage() {
  const session = await getServerSession(authOptions);
  // The layout gates unauthenticated users, but the session can be revoked
  // between the layout check and this render (e.g. "sign out of all devices"),
  // in which case session is null here — redirect instead of crashing.
  if (!session?.user?.id) redirect('/auth/signin');
  const { t, locale } = await getServerDictionary();
  const activeRelation = await getActiveRelation(session.user.id);

  return (
    <div>
      <PortalTabs />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.portal.tabs.journey}</h1>
        <p className="text-gray-500 mt-1">{t.portal.journeySubtitle}</p>
      </div>

      {activeRelation && (
        <div className="mb-6">
          <JourneyTracker status={activeRelation.pipelineStatus} />
        </div>
      )}

      {/* Mentor & Company */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-blue-600" />
            <CardTitle>{t.portal.myMentorship}</CardTitle>
          </div>
        </CardHeader>

        {!activeRelation ? (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <User className="h-8 w-8 text-gray-400" />
            </div>
            <p className="text-gray-500 font-medium">{t.portal.noMentor}</p>
            <p className="text-sm text-gray-400 mt-1">
              {t.portal.noMentorHint}
            </p>
            <p className="text-sm text-gray-400 mt-1">{t.portal.noRelationSection}</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <StatusBadge status={activeRelation.status} />
              <span className="text-xs text-gray-400">
                {t.portal.since} {formatDate(activeRelation.startDate, locale)}
              </span>
            </div>

            {/* Mentor */}
            <div className="p-4 bg-blue-50 rounded-xl">
              <p className="text-xs font-medium text-blue-500 uppercase tracking-wide mb-2">
                {t.portal.yourMentor}
              </p>
              <p className="font-semibold text-gray-900">{activeRelation.mentor.fullName}</p>
              <a href={`mailto:${activeRelation.mentor.email}`} className="text-sm text-gray-600 hover:text-blue-600 hover:underline break-all">{activeRelation.mentor.email}</a>
              {activeRelation.mentor.phone && (
                <p className="text-sm text-gray-600">{activeRelation.mentor.phone}</p>
              )}
              {activeRelation.mentor.department && (
                <p className="text-sm text-gray-500 mt-1">{activeRelation.mentor.department}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/messages/${activeRelation.id}`} className="inline-flex items-center gap-1.5 bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors">
                  <MessageCircle className="h-4 w-4" />
                  {t.portal.messageMentor}
                </Link>
                {activeRelation.mentor.publicProfile === true && (
                  <Link href={`/p/${activeRelation.mentor.id}`} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors">
                    <ExternalLink className="h-4 w-4" />
                    {t.portal.viewMentorProfile}
                  </Link>
                )}
              </div>
            </div>

            {/* Company */}
            {activeRelation.company && (
              <div className="p-4 bg-green-50 rounded-xl">
                <p className="text-xs font-medium text-green-500 uppercase tracking-wide mb-2">
                  {t.portal.assignedCompany}
                </p>
                <p className="font-semibold text-gray-900">{activeRelation.company.name}</p>
                {activeRelation.company.industry && (
                  <p className="text-sm text-gray-600">{activeRelation.company.industry}</p>
                )}
                {activeRelation.company.contactEmail && (
                  <p className="text-sm text-gray-600">{activeRelation.company.contactEmail}</p>
                )}
                {activeRelation.company.description && (
                  <p className="text-sm text-gray-500 mt-2">{activeRelation.company.description}</p>
                )}
              </div>
            )}

            {/* Recent Interactions */}
            {activeRelation.interactions.length > 0 && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <BookOpen className="h-4 w-4" />
                  {t.portal.recentInteractions}
                </p>
                <div className="space-y-2">
                  {activeRelation.interactions.map((interaction) => (
                    <div
                      key={interaction.id}
                      className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0"
                    >
                      <InteractionTypeBadge type={interaction.type} className="text-xs flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm text-gray-700 truncate">{interaction.notes}</p>
                        <p className="text-xs text-gray-400">
                          {formatDate(interaction.date, locale)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
