import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Users, Building2, BookOpen, Bell } from 'lucide-react';
import Link from 'next/link';
import { PIPELINE_STATUSES, pipelineLabel } from '@/lib/pipeline';

async function getStats() {
  const [menteeCount, mentorCount, companyCount, activeRelations, recentRelations, recentCandidates, pipelineGroups] =
    await Promise.all([
      prisma.user.count({ where: { role: 'MENTEE' } }),
      prisma.user.count({ where: { role: 'MENTOR' } }),
      prisma.company.count(),
      prisma.mentorshipRelation.count({ where: { status: 'ACTIVE' } }),
      prisma.mentorshipRelation.findMany({
        take: 5,
        orderBy: { startDate: 'desc' },
        include: {
          mentor: { select: { fullName: true } },
          mentee: { select: { fullName: true } },
          company: { select: { name: true } },
        },
      }),
      prisma.user.findMany({
        where: { role: 'MENTEE' },
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          fullName: true,
          email: true,
          university: true,
          skills: true,
          graduationYear: true,
          createdAt: true,
        },
      }),
      prisma.mentorshipRelation.groupBy({
        by: ['pipelineStatus'],
        _count: { _all: true },
      }),
    ]);

  const pipelineCounts = Object.fromEntries(
    pipelineGroups.map((g) => [g.pipelineStatus, g._count._all])
  ) as Record<string, number>;

  return {
    menteeCount,
    mentorCount,
    companyCount,
    activeRelations,
    recentRelations,
    recentCandidates,
    pipelineCounts,
  };
}

export default async function AdminDashboard() {
  await getServerSession(authOptions);
  const stats = await getStats();

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
        <p className="text-gray-500 mt-1">Overview of your internship management system</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <Card>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
              <Users className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.menteeCount}</p>
              <p className="text-sm text-gray-500">Mentees</p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
              <Users className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.mentorCount}</p>
              <p className="text-sm text-gray-500">Mentors</p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
              <Building2 className="h-6 w-6 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.companyCount}</p>
              <p className="text-sm text-gray-500">Companies</p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-orange-100 rounded-xl flex items-center justify-center">
              <BookOpen className="h-6 w-6 text-orange-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.activeRelations}</p>
              <p className="text-sm text-gray-500">Active Mentorships</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Pipeline distribution */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
          <CardDescription>Mentees per stage</CardDescription>
        </CardHeader>
        {(() => {
          const max = Math.max(1, ...PIPELINE_STATUSES.map((s) => stats.pipelineCounts[s] ?? 0));
          return (
            <div className="space-y-2">
              {PIPELINE_STATUSES.map((s) => {
                const count = stats.pipelineCounts[s] ?? 0;
                return (
                  <div key={s} className="flex items-center gap-3">
                    <span className="text-xs text-gray-600 w-56 flex-shrink-0 truncate">{pipelineLabel(s)}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
                      <div
                        className="bg-blue-500 h-full rounded-full"
                        style={{ width: `${(count / max) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs font-medium text-gray-700 w-8 text-right flex-shrink-0">{count}</span>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Mentorships */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Recent Mentorships</CardTitle>
                <CardDescription>Latest mentor-mentee assignments</CardDescription>
              </div>
              <Link href="/admin/mentorship" className="text-sm text-blue-600 hover:underline">
                View all
              </Link>
            </div>
          </CardHeader>
          <div className="space-y-3">
            {stats.recentRelations.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">No mentorships yet</p>
            )}
            {stats.recentRelations.map((rel) => (
              <div key={rel.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {rel.mentee.fullName} → {rel.mentor.fullName}
                  </p>
                  {rel.company && (
                    <p className="text-xs text-gray-500">{rel.company.name}</p>
                  )}
                </div>
                <StatusBadge status={rel.status} />
              </div>
            ))}
          </div>
        </Card>

        {/* Recent Candidates */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>New Candidates</CardTitle>
                <CardDescription>Recently registered mentees</CardDescription>
              </div>
              <Link href="/admin/candidates" className="text-sm text-blue-600 hover:underline">
                View all
              </Link>
            </div>
          </CardHeader>
          <div className="space-y-3">
            {stats.recentCandidates.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">No candidates yet</p>
            )}
            {stats.recentCandidates.map((candidate) => (
              <div key={candidate.id} className="flex items-start justify-between py-2">
                <div>
                  <p className="text-sm font-medium text-gray-900">{candidate.fullName}</p>
                  <p className="text-xs text-gray-500">{candidate.university || candidate.email}</p>
                </div>
                <div className="flex flex-wrap gap-1 max-w-[120px] justify-end">
                  {(candidate.skills as string[]).slice(0, 2).map((skill) => (
                    <Badge key={skill} variant="info" className="text-xs">
                      {skill}
                    </Badge>
                  ))}
                  {(candidate.skills as string[]).length > 2 && (
                    <Badge variant="default" className="text-xs">
                      +{(candidate.skills as string[]).length - 2}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Quick Actions */}
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Link href="/admin/companies" className="block">
          <Card className="hover:border-blue-200 hover:shadow-md transition-all cursor-pointer">
            <div className="flex items-center gap-3">
              <Building2 className="h-5 w-5 text-blue-600" />
              <span className="font-medium text-gray-700">Manage Companies</span>
            </div>
          </Card>
        </Link>
        <Link href="/admin/candidates" className="block">
          <Card className="hover:border-blue-200 hover:shadow-md transition-all cursor-pointer">
            <div className="flex items-center gap-3">
              <Users className="h-5 w-5 text-blue-600" />
              <span className="font-medium text-gray-700">Browse Candidates</span>
            </div>
          </Card>
        </Link>
        <Link href="/admin/invite" className="block">
          <Card className="hover:border-blue-200 hover:shadow-md transition-all cursor-pointer">
            <div className="flex items-center gap-3">
              <Bell className="h-5 w-5 text-blue-600" />
              <span className="font-medium text-gray-700">Send Invitations</span>
            </div>
          </Card>
        </Link>
      </div>
    </div>
  );
}
