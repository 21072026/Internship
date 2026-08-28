import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getServerDictionary } from '@/i18n/server';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { JourneyTracker } from '@/components/JourneyTracker';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/Badge';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { AutoLoggedBadge } from '@/components/AutoLoggedBadge';
import { User, Building2, BookOpen, ExternalLink, MessageCircle } from 'lucide-react';
import { formatDate } from '@/lib/relativeTime';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import { ArchivedNotice } from '@/components/ArchivedNotice';
import { menteeRelationWhere, pickMenteeRelation } from '@/lib/menteeRelation';

// ACTIVE, else the latest COMPLETED one shown as an archive (#1408).
async function getMenteeRelation(menteeId: string) {
  const relations = await prisma.mentorshipRelation.findMany({
    where: menteeRelationWhere(menteeId),
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
  return pickMenteeRelation(relations);
}

export default async function PortalJourneyPage() {
  const session = await getServerSession(authOptions);
  // The layout gates unauthenticated users, but the session can be revoked
  // between the layout check and this render (e.g. "sign out of all devices"),
  // in which case session is null here — redirect instead of crashing.
  if (!session?.user?.id) redirect('/auth/signin');
  const { t, locale } = await getServerDictionary();
  const { relation, isArchived } = await getMenteeRelation(session.user.id);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.portal.tabs.journey}</h1>
        <p className="text-gray-500 mt-1">{t.portal.journeySubtitle}</p>
      </div>

      {relation && (
        <div className="mb-6">
          <JourneyTracker status={relation.pipelineStatus} />
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

        {!relation ? (
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
              <StatusBadge status={relation.status} />
              <span className="text-xs text-gray-400">
                {isArchived && relation.completedAt
                  ? `${t.portal.archived.completedOn} ${formatDate(relation.completedAt, locale)}`
                  : `${t.portal.since} ${formatDate(relation.startDate, locale)}`}
              </span>
            </div>

            {isArchived && <ArchivedNotice title={t.portal.archived.title} hint={t.portal.archived.hint} />}

            {/* Mentor */}
            <div className="p-4 bg-blue-50 rounded-xl">
              <p className="text-xs font-medium text-blue-500 uppercase tracking-wide mb-2">
                {t.portal.yourMentor}
              </p>
              <p className="font-semibold text-gray-900">
                <PersonHoverCard personId={relation.mentor.id} name={relation.mentor.fullName} role="MENTOR" />
              </p>
              <a href={`mailto:${relation.mentor.email}`} className="text-sm text-gray-600 hover:text-blue-600 hover:underline break-all">{relation.mentor.email}</a>
              {relation.mentor.phone && (
                <p className="text-sm text-gray-600">{relation.mentor.phone}</p>
              )}
              {relation.mentor.department && (
                <p className="text-sm text-gray-500 mt-1">{relation.mentor.department}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/messages/${relation.id}`} className="inline-flex items-center gap-1.5 bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors">
                  <MessageCircle className="h-4 w-4" />
                  {t.portal.messageMentor}
                </Link>
                {relation.mentor.publicProfile === true && (
                  <Link href={`/p/${relation.mentor.id}`} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors">
                    <ExternalLink className="h-4 w-4" />
                    {t.portal.viewMentorProfile}
                  </Link>
                )}
              </div>
            </div>

            {/* Company */}
            {relation.company && (
              <div className="p-4 bg-green-50 rounded-xl">
                <p className="text-xs font-medium text-green-500 uppercase tracking-wide mb-2">
                  {t.portal.assignedCompany}
                </p>
                <p className="font-semibold text-gray-900">{relation.company.name}</p>
                {relation.company.industry && (
                  <p className="text-sm text-gray-600">{relation.company.industry}</p>
                )}
                {relation.company.contactEmail && (
                  <p className="text-sm text-gray-600">{relation.company.contactEmail}</p>
                )}
                {relation.company.description && (
                  <p className="text-sm text-gray-500 mt-2">{relation.company.description}</p>
                )}
              </div>
            )}

            {/* Recent Interactions */}
            {relation.interactions.length > 0 && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <BookOpen className="h-4 w-4" />
                  {t.portal.recentInteractions}
                </p>
                <div className="space-y-2">
                  {relation.interactions.map((interaction) => (
                    <div
                      key={interaction.id}
                      className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0"
                    >
                      <InteractionTypeBadge type={interaction.type} className="text-xs flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm text-gray-700 truncate">{interaction.notes}</p>
                        <AutoLoggedBadge autoLogged={interaction.autoLogged} className="text-xs mt-1" />
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
