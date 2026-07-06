import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { OnboardingChecklist } from '@/components/OnboardingChecklist';
import { MentorAttentionQueue } from '@/components/MentorAttentionQueue';
import { getServerDictionary } from "@/i18n/server";
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getAttentionItems } from '@/lib/mentorAttention';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { Users, BookOpen, MessageSquare, Calendar } from 'lucide-react';
import Link from 'next/link';
import { formatDate } from '@/lib/relativeTime';

async function getMentorData(mentorId: string) {
  const relations = await prisma.mentorshipRelation.findMany({
    where: { mentorId },
    include: {
      mentee: {
        select: {
          id: true,
          fullName: true,
          email: true,
          university: true,
          department: true,
          graduationYear: true,
          skills: true,
          phone: true,
          cvUrl: true,
        },
      },
      company: { select: { id: true, name: true, industry: true } },
      interactions: {
        orderBy: { date: 'desc' },
        take: 3,
      },
      _count: { select: { interactions: true } },
    },
    orderBy: { startDate: 'desc' },
  });

  const recentInteractions = await prisma.interactionLog.findMany({
    where: { relation: { mentorId } },
    include: {
      relation: {
        include: {
          mentee: { select: { fullName: true } },
        },
      },
    },
    orderBy: { date: 'desc' },
    take: 10,
  });

  return { relations, recentInteractions };
}

export default async function MentorDashboard() {
  const session = await getServerSession(authOptions);
  // The layout gates unauthenticated users, but the session can be revoked
  // (e.g. "sign out of all devices") between that check and this render, in
  // which case session is null here — redirect instead of crashing.
  if (!session?.user?.id) redirect('/auth/signin');
  const { t, locale } = await getServerDictionary();
  const { relations, recentInteractions } = await getMentorData(session.user.id);
  const attentionItems = await getAttentionItems(session.user.id);

  const activeRelations = relations.filter((r) => r.status === 'ACTIVE');

  return (
    <div>
      <OnboardingChecklist />
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t.mentor.welcomeBack}, {session.user.name}
        </h1>
        <p className="text-gray-500 mt-1">{t.mentor.dashSubtitle}</p>
      </div>

      <MentorAttentionQueue items={attentionItems} t={t} />

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
        <Card>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
              <Users className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{activeRelations.length}</p>
              <p className="text-sm text-gray-500">{t.mentor.activeMentees}</p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
              <BookOpen className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">
                {relations.reduce((sum, r) => sum + r._count.interactions, 0)}
              </p>
              <p className="text-sm text-gray-500">{t.mentor.totalInteractions}</p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
              <MessageSquare className="h-6 w-6 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{relations.length}</p>
              <p className="text-sm text-gray-500">{t.mentor.totalRelations}</p>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Mentees */}
        <Card>
          <CardHeader>
            <CardTitle>{t.mentor.myMentees}</CardTitle>
            <CardDescription>{t.mentor.currentRelationships}</CardDescription>
          </CardHeader>
          <div className="space-y-4">
            {activeRelations.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">{t.mentor.noActiveMentees}</p>
            )}
            {activeRelations.map((rel) => {
              const lastInteraction = rel.interactions[0];
              const daysSince = lastInteraction
                ? Math.floor(
                    (Date.now() - new Date(lastInteraction.date).getTime()) / (1000 * 60 * 60 * 24)
                  )
                : null;

              return (
                <div key={rel.id} className="border border-gray-100 rounded-xl p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="font-medium text-gray-900">{rel.mentee.fullName}</p>
                      <p className="text-xs text-gray-500">{rel.mentee.university}</p>
                    </div>
                    <StatusBadge status={rel.status} />
                  </div>
                  {rel.company && (
                    <p className="text-xs text-blue-600 mb-2">📍 {rel.company.name}</p>
                  )}
                  <div className="flex flex-wrap gap-1 mb-3">
                    {(rel.mentee.skills as string[]).slice(0, 3).map((skill) => (
                      <Badge key={skill} variant="info" className="text-xs">
                        {skill}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {daysSince !== null
                        ? daysSince === 0
                          ? t.mentor.interactedToday
                          : t.mentor.lastInteraction.replace('{d}', String(daysSince))
                        : t.mentor.noInteractionsYet}
                    </span>
                    <Link
                      href={`/mentor/mentees/${rel.id}`}
                      className="text-blue-600 hover:underline"
                    >
                      {t.mentor.viewDetails} →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Recent Interactions */}
        <Card>
          <CardHeader>
            <CardTitle>{t.mentor.recentInteractions}</CardTitle>
            <CardDescription>{t.mentor.latestInteractions}</CardDescription>
          </CardHeader>
          <div className="space-y-3">
            {recentInteractions.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">{t.mentor.noInteractionsYet}</p>
            )}
            {recentInteractions.map((interaction) => (
              <div key={interaction.id} className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
                <div
                  className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${
                    interaction.type === 'Meeting'
                      ? 'bg-blue-500'
                      : interaction.type === 'Feedback'
                      ? 'bg-green-500'
                      : 'bg-orange-500'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <InteractionTypeBadge type={interaction.type} className="text-xs" />
                    <span className="text-xs text-gray-500">
                      with {interaction.relation.mentee.fullName}
                    </span>
                  </div>
                  <p className="text-sm text-gray-700 truncate">{interaction.notes}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {formatDate(interaction.date, locale)}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-gray-100">
            <Link href="/mentor/interactions" className="text-sm text-blue-600 hover:underline">
              View all interactions →
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
