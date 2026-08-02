import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { GraduationCap, Github, ExternalLink, Trello, ArrowLeft } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { Badge } from '@/components/ui/Badge';
import { mergeTeam, internCount, type TeamMember } from '@/lib/projectTeam';
import { ProjectQuickActions } from '@/components/project/ProjectQuickActions';
import { ProjectWeeklyMeeting } from '@/components/project/ProjectWeeklyMeeting';
import { ProjectGoals } from '@/components/project/ProjectGoals';
import { ProjectJoinRequests } from '@/components/project/ProjectJoinRequests';
import { ProjectMembersPanel } from '@/components/project/ProjectMembersPanel';

export const dynamic = 'force-dynamic';

const STATUS_VARIANT: Record<string, 'success' | 'info' | 'default' | 'warning'> = {
  DRAFT: 'warning', ACTIVE: 'success', COMPLETED: 'info', ARCHIVED: 'default', CANCELLED: 'default',
};

// Project detail (#616). Public visitors get the PII-free showcase view of
// public projects, exactly as before. Signed-in internal viewers — admins,
// the owning mentor, the owning company — also see status, dates, goals,
// members and task progress.
//
// The people actually working on the project (#51) belong in that second group:
// a mentee member used to get the visitor's view of their own project — a name,
// three links and "2 interns" — even though they sit in the project's group chat
// with everyone on it. They now see the roster, the recurring meeting, their own
// goals, and shortcuts to the owner and the group chat.
export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t } = await getServerDictionary();
  const session = await getServerSession(authOptions);

  const p = await prisma.project.findUnique({
    where: { id },
    select: {
      name: true, description: true, technologies: true, repoUrl: true, demoUrl: true, boardUrl: true, status: true,
      isPublic: true, goals: true, startDate: true, endDate: true,
      ownerType: true, ownerUserId: true, ownerCompanyId: true,
      ownerUser: { select: { id: true, fullName: true } }, ownerCompany: { select: { name: true } },
      members: {
        orderBy: { addedAt: 'asc' },
        select: { role: true, functionalRole: true, addedAt: true, user: { select: { id: true, fullName: true } } },
      },
      relations: {
        where: { status: 'ACTIVE' },
        select: {
          mentee: { select: { id: true, fullName: true } },
          mentor: { select: { id: true, fullName: true } },
        },
      },
    },
  });
  if (!p) notFound();

  const role = session?.user.role;
  const team = mergeTeam(p.members, p.relations);
  const interns = internCount(team);
  const isMember = !!session && team.some((m) => m.id === session.user.id);
  const isLead =
    role === 'ADMIN' ||
    (!!session && p.ownerUserId === session.user.id) ||
    (!!session && p.members.some((m) => m.user.id === session.user.id && m.role === 'OWNER'));
  const canInternal =
    isLead ||
    isMember ||
    (role === 'COMPANY' && !!session?.user.companyId && p.ownerCompanyId === session.user.companyId);
  if (!p.isPublic && !canInternal) notFound();

  // A public project accepts join requests from anyone signed in who is not on
  // it yet (mentees and mentors alike).
  const canRequestToJoin = !!session && !isMember && p.isPublic && (role === 'MENTEE' || role === 'MENTOR');
  const existingRequest = canRequestToJoin
    ? await prisma.projectJoinRequest.findUnique({
        where: { projectId_userId: { projectId: id, userId: session!.user.id } },
        select: { status: true },
      })
    : null;

  const tech = Array.isArray(p.technologies) ? (p.technologies as string[]) : [];
  const owner = p.ownerType === 'COMPANY' ? p.ownerCompany?.name : p.ownerUser?.fullName;
  const statusLabel = t.projects[p.status.toLowerCase() as 'draft' | 'active' | 'completed' | 'archived' | 'cancelled'];
  const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '…');

  const roleLabel = (m: TeamMember) =>
    m.role === 'MENTEE'
      ? m.functionalRole
        ? (t.projects.functionalRoles as Record<string, string>)[m.functionalRole]
        : t.projects.roleMentee
      : m.role === 'OWNER'
        ? t.projects.roleOwner
        : t.projects.roleMentorMember;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 px-3 py-6 sm:px-4 sm:py-12">
      <div className="max-w-2xl mx-auto">
        {/* Back link: internal viewers return to their own project list (where
            they came from); public visitors get the showcase header link. */}
        <Link
          href={role === 'ADMIN' ? '/admin/projects' : role === 'MENTOR' ? '/mentor/projects' : '/projects'}
          className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6"
        >
          {isLead
            ? <><ArrowLeft className="h-4 w-4" /> {t.projects.allProjects}</>
            : <><GraduationCap className="h-4 w-4 text-blue-600" /> {t.projects.showcaseTitle}</>}
        </Link>
        <div className="rounded-2xl border border-gray-200 bg-white p-5 sm:p-8">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900">{p.name}</h1>
            {canInternal && <Badge variant={STATUS_VARIANT[p.status]}>{statusLabel}</Badge>}
            {p.isPublic && canInternal && <Badge variant="purple">{t.projects.public}</Badge>}
          </div>
          {owner && <p className="text-sm text-gray-500 mt-1">{t.projects.by} {owner}</p>}
          {p.description && <p className="text-gray-700 mt-4 whitespace-pre-wrap">{p.description}</p>}
          {tech.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-5">
              {tech.map((x) => <span key={x} className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 text-sm">{x}</span>)}
            </div>
          )}
          <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {p.repoUrl && <a href={p.repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Github className="h-4 w-4" />{t.projects.repo}</a>}
            {p.demoUrl && <a href={p.demoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><ExternalLink className="h-4 w-4" />{t.projects.demo}</a>}
            {p.boardUrl && <a href={p.boardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Trello className="h-4 w-4" />{t.projects.board}</a>}
          </div>

          {session && (isMember || canRequestToJoin) && (
            <ProjectQuickActions
              projectId={id}
              ownerUserId={p.ownerUser?.id ?? null}
              isMember={isMember}
              canRequestToJoin={canRequestToJoin}
              joinStatus={existingRequest?.status ?? null}
            />
          )}

          {canInternal ? (
            <div className="mt-8 border-t border-gray-100 pt-6 space-y-5" data-testid="project-internal">
              {(p.startDate || p.endDate) && (
                <p className="text-sm text-gray-500">{fmt(p.startDate)} – {fmt(p.endDate)}</p>
              )}
              {p.goals && (
                <div>
                  <h2 className="text-sm font-semibold text-gray-900 mb-1">{t.projects.goalsLabel}</h2>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{p.goals}</p>
                </div>
              )}
              <div>
                <h2 className="text-sm font-semibold text-gray-900 mb-1.5" data-testid="project-team-heading">
                  {t.projects.team} ({team.length})
                </h2>
                {team.length === 0 ? (
                  <p className="text-sm text-gray-400">{t.projects.noMembers}</p>
                ) : (
                  <ul className="space-y-1" data-testid="project-team">
                    {team.map((m) => (
                      <li key={m.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-gray-800">{m.fullName}</span>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">{roleLabel(m)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1.5 text-xs text-gray-400">{interns} {t.projects.members}</p>
              </div>

              {isLead && session && <ProjectMembersPanel projectId={id} myId={session.user.id} />}

              {isLead && <ProjectJoinRequests projectId={id} />}

              <ProjectWeeklyMeeting projectId={id} canManage={isLead} />

              {session && (
                <ProjectGoals projectId={id} myId={session.user.id} canLead={isLead} isMember={isMember} />
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-400 mt-6">{interns} {t.projects.members}</p>
          )}
        </div>
      </div>
    </div>
  );
}
