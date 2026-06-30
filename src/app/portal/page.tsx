import { getServerSession } from 'next-auth';
import { OnboardingChecklist } from '@/components/OnboardingChecklist';
import { GoalsPanel } from '@/components/GoalsPanel';
import { EvaluationPanel } from '@/components/EvaluationPanel';
import { JourneyTracker } from '@/components/JourneyTracker';
import { NotesPanel } from '@/components/NotesPanel';
import { MeetingRequestsPanel } from '@/components/MeetingRequestsPanel';
import { QuestionsPanel } from '@/components/QuestionsPanel';
import { getServerDictionary } from "@/i18n/server";
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { User, Building2, BookOpen, ExternalLink, MessageCircle, Mail, Github, Linkedin } from 'lucide-react';
import Link from 'next/link';

async function getMenteeData(menteeId: string) {
  const [user, activeRelation] = await Promise.all([
    prisma.user.findUnique({
      where: { id: menteeId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        university: true,
        department: true,
        graduationYear: true,
        skills: true,
        cvUrl: true,
        githubUrl: true,
        linkedinUrl: true,
        portfolioUrl: true,
        createdAt: true,
      },
    }),
    prisma.mentorshipRelation.findFirst({
      where: { menteeId, status: 'ACTIVE' },
      include: {
        mentor: {
          select: { id: true, fullName: true, email: true, department: true, phone: true },
        },
        company: true,
        interactions: {
          orderBy: { date: 'desc' },
          take: 5,
        },
      },
    }),
  ]);

  return { user, activeRelation };
}

export default async function PortalDashboard() {
  const session = await getServerSession(authOptions);
  const { t, locale } = await getServerDictionary();
  const { user, activeRelation } = await getMenteeData(session!.user.id);

  const profileComplete = user?.university && user?.skills && (user.skills as string[]).length > 0;

  return (
    <div>
      <OnboardingChecklist />
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          {t.portal.welcome}, {session!.user.name}!
        </h1>
        <p className="text-gray-500 mt-1">{t.portal.dashSubtitle}</p>
      </div>

      {!profileComplete && (
        <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-xl flex items-center justify-between">
          <div>
            <p className="font-medium text-yellow-800">{t.portal.completeProfile}</p>
            <p className="text-sm text-yellow-600 mt-0.5">
              {t.portal.completeProfileHint}
            </p>
          </div>
          <Link
            href="/onboarding"
            className="bg-yellow-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-yellow-600 transition-colors flex-shrink-0 ml-4"
          >
            {t.portal.completeProfileCta}
          </Link>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Profile Summary */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <User className="h-5 w-5 text-blue-600" />
              <CardTitle>{t.portal.myProfile}</CardTitle>
            </div>
          </CardHeader>
          <div className="space-y-3">
            <div>
              <p className="text-xs text-gray-500">{t.profileForm.fullName}</p>
              <p className="text-sm font-medium text-gray-900">{user?.fullName}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">{t.account.email}</p>
              <p className="text-sm text-gray-900">{user?.email}</p>
            </div>
            {user?.phone && (
              <div>
                <p className="text-xs text-gray-500">{t.profileForm.phone}</p>
                <p className="text-sm text-gray-900">{user.phone}</p>
              </div>
            )}
            {user?.university && (
              <div>
                <p className="text-xs text-gray-500">{t.profileForm.university}</p>
                <p className="text-sm text-gray-900">{user.university}</p>
              </div>
            )}
            {user?.department && (
              <div>
                <p className="text-xs text-gray-500">{t.profileForm.department}</p>
                <p className="text-sm text-gray-900">{user.department}</p>
              </div>
            )}
            {user?.graduationYear && (
              <div>
                <p className="text-xs text-gray-500">{t.profileForm.graduationYear}</p>
                <p className="text-sm text-gray-900">{user.graduationYear}</p>
              </div>
            )}
            {user?.skills && (user.skills as string[]).length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1.5">{t.profileForm.skills}</p>
                <div className="flex flex-wrap gap-1">
                  {(user.skills as string[]).map((skill) => (
                    <Badge key={skill} variant="info" className="text-xs">
                      {skill}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {(user?.cvUrl || user?.githubUrl || user?.linkedinUrl || user?.portfolioUrl) && (
              <div className="flex flex-wrap gap-2 pt-1">
                {user?.cvUrl && (
                  <a href={user.cvUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                    <ExternalLink className="h-3 w-3" />{t.portal.viewCv}
                  </a>
                )}
                {user?.githubUrl && (
                  <a href={user.githubUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-gray-700 hover:underline"><Github className="h-3 w-3" />GitHub</a>
                )}
                {user?.linkedinUrl && (
                  <a href={user.linkedinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-gray-700 hover:underline"><Linkedin className="h-3 w-3" />LinkedIn</a>
                )}
                {user?.portfolioUrl && (
                  <a href={user.portfolioUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-gray-700 hover:underline"><ExternalLink className="h-3 w-3" />{t.profileForm.portfolio}</a>
                )}
              </div>
            )}
          </div>
          <div className="mt-4 pt-4 border-t border-gray-100">
            <Link href="/portal/profile" className="text-sm text-blue-600 hover:underline">
              {t.portal.editProfile} →
            </Link>
          </div>
        </Card>

        {/* Mentor & Company */}
        <Card className="lg:col-span-2">
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
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <StatusBadge status={activeRelation.status} />
                <span className="text-xs text-gray-400">
                  {t.portal.since} {new Date(activeRelation.startDate).toLocaleDateString(locale)}
                </span>
              </div>

              {/* Mentor */}
              <div className="p-4 bg-blue-50 rounded-xl">
                <p className="text-xs font-medium text-blue-500 uppercase tracking-wide mb-2">
                  {t.portal.yourMentor}
                </p>
                <p className="font-semibold text-gray-900">{activeRelation.mentor.fullName}</p>
                <p className="text-sm text-gray-600">{activeRelation.mentor.email}</p>
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
                  <a href={`mailto:${activeRelation.mentor.email}`} className="inline-flex items-center gap-1.5 border border-gray-300 text-gray-700 text-sm px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors">
                    <Mail className="h-4 w-4" />
                    {t.portal.emailMentor}
                  </a>
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
                        <Badge
                          variant={
                            interaction.type === 'Meeting'
                              ? 'info'
                              : interaction.type === 'Feedback'
                              ? 'success'
                              : 'warning'
                          }
                          className="text-xs flex-shrink-0"
                        >
                          {interaction.type}
                        </Badge>
                        <div className="min-w-0">
                          <p className="text-sm text-gray-700 truncate">{interaction.notes}</p>
                          <p className="text-xs text-gray-400">
                            {new Date(interaction.date).toLocaleDateString(locale)}
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

      {activeRelation && (
        <>
          <div className="mt-6">
            <JourneyTracker status={activeRelation.pipelineStatus} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            <GoalsPanel relationId={activeRelation.id} />
            <EvaluationPanel relationId={activeRelation.id} audience="MENTOR" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            <MeetingRequestsPanel relationId={activeRelation.id} mode="request" />
            <QuestionsPanel relationId={activeRelation.id} mode="ask" />
          </div>
        </>
      )}

      <div className="mt-6">
        <NotesPanel />
      </div>
    </div>
  );
}
