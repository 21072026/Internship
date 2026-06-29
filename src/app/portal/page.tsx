import { getServerSession } from 'next-auth';
import { OnboardingChecklist } from '@/components/OnboardingChecklist';
import { GoalsPanel } from '@/components/GoalsPanel';
import { EvaluationPanel } from '@/components/EvaluationPanel';
import { getServerDictionary } from "@/i18n/server";
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { User, Building2, BookOpen, ExternalLink } from 'lucide-react';
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
  const { t } = await getServerDictionary();
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
            Complete Profile
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
              <p className="text-xs text-gray-500">Full Name</p>
              <p className="text-sm font-medium text-gray-900">{user?.fullName}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Email</p>
              <p className="text-sm text-gray-900">{user?.email}</p>
            </div>
            {user?.phone && (
              <div>
                <p className="text-xs text-gray-500">Phone</p>
                <p className="text-sm text-gray-900">{user.phone}</p>
              </div>
            )}
            {user?.university && (
              <div>
                <p className="text-xs text-gray-500">University</p>
                <p className="text-sm text-gray-900">{user.university}</p>
              </div>
            )}
            {user?.department && (
              <div>
                <p className="text-xs text-gray-500">Department</p>
                <p className="text-sm text-gray-900">{user.department}</p>
              </div>
            )}
            {user?.graduationYear && (
              <div>
                <p className="text-xs text-gray-500">Graduation Year</p>
                <p className="text-sm text-gray-900">{user.graduationYear}</p>
              </div>
            )}
            {user?.skills && (user.skills as string[]).length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1.5">Skills</p>
                <div className="flex flex-wrap gap-1">
                  {(user.skills as string[]).map((skill) => (
                    <Badge key={skill} variant="info" className="text-xs">
                      {skill}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {user?.cvUrl && (
              <a
                href={user.cvUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-blue-600 hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                View CV
              </a>
            )}
          </div>
          <div className="mt-4 pt-4 border-t border-gray-100">
            <Link href="/portal/profile" className="text-sm text-blue-600 hover:underline">
              Edit profile →
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
              <p className="text-gray-500 font-medium">No mentor assigned yet</p>
              <p className="text-sm text-gray-400 mt-1">
                An admin will assign you a mentor once your profile is reviewed.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <StatusBadge status={activeRelation.status} />
                <span className="text-xs text-gray-400">
                  Since {new Date(activeRelation.startDate).toLocaleDateString()}
                </span>
              </div>

              {/* Mentor */}
              <div className="p-4 bg-blue-50 rounded-xl">
                <p className="text-xs font-medium text-blue-500 uppercase tracking-wide mb-2">
                  Your Mentor
                </p>
                <p className="font-semibold text-gray-900">{activeRelation.mentor.fullName}</p>
                <p className="text-sm text-gray-600">{activeRelation.mentor.email}</p>
                {activeRelation.mentor.phone && (
                  <p className="text-sm text-gray-600">{activeRelation.mentor.phone}</p>
                )}
                {activeRelation.mentor.department && (
                  <p className="text-sm text-gray-500 mt-1">{activeRelation.mentor.department}</p>
                )}
              </div>

              {/* Company */}
              {activeRelation.company && (
                <div className="p-4 bg-green-50 rounded-xl">
                  <p className="text-xs font-medium text-green-500 uppercase tracking-wide mb-2">
                    Assigned Company
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
                    Recent Interactions
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
                            {new Date(interaction.date).toLocaleDateString()}
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

        {activeRelation && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            <GoalsPanel relationId={activeRelation.id} />
            <EvaluationPanel relationId={activeRelation.id} audience="MENTOR" />
          </div>
        )}
      </div>
    </div>
  );
}
