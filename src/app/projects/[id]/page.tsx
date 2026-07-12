import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { GraduationCap, Github, ExternalLink, Trello, CheckCircle2, Circle } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { Badge } from '@/components/ui/Badge';

export const dynamic = 'force-dynamic';

const STATUS_VARIANT: Record<string, 'success' | 'info' | 'default' | 'warning'> = {
  DRAFT: 'warning', ACTIVE: 'success', COMPLETED: 'info', ARCHIVED: 'default', CANCELLED: 'default',
};

// Project detail (#616). Public visitors get the PII-free showcase view of
// public projects, exactly as before. Signed-in internal viewers — admins,
// the owning mentor, the owning company — also see private projects plus an
// internal section: status, dates, goals, members and task progress.
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
      ownerUser: { select: { fullName: true } }, ownerCompany: { select: { name: true } },
      tasks: { orderBy: { order: 'asc' }, select: { id: true, title: true, done: true } },
      relations: { where: { status: 'ACTIVE' }, select: { mentee: { select: { id: true, fullName: true } } } },
      _count: { select: { relations: true } },
    },
  });
  if (!p) notFound();

  const role = session?.user.role;
  const canInternal =
    role === 'ADMIN' ||
    (!!session && p.ownerUserId === session.user.id) ||
    (role === 'COMPANY' && !!session?.user.companyId && p.ownerCompanyId === session.user.companyId);
  if (!p.isPublic && !canInternal) notFound();

  const tech = Array.isArray(p.technologies) ? (p.technologies as string[]) : [];
  const owner = p.ownerType === 'COMPANY' ? p.ownerCompany?.name : p.ownerUser?.fullName;
  const statusLabel = t.projects[p.status.toLowerCase() as 'draft' | 'active' | 'completed' | 'archived' | 'cancelled'];
  const done = p.tasks.filter((tk) => tk.done).length;
  const pct = p.tasks.length ? Math.round((done / p.tasks.length) * 100) : 0;
  const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '…');

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <Link href="/projects" className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6">
          <GraduationCap className="h-4 w-4 text-blue-600" /> {t.projects.showcaseTitle}
        </Link>
        <div className="bg-white rounded-2xl border border-gray-200 p-8">
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
          <div className="flex gap-4 mt-6 text-sm">
            {p.repoUrl && <a href={p.repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Github className="h-4 w-4" />{t.projects.repo}</a>}
            {p.demoUrl && <a href={p.demoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><ExternalLink className="h-4 w-4" />{t.projects.demo}</a>}
            {p.boardUrl && <a href={p.boardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Trello className="h-4 w-4" />{t.projects.board}</a>}
          </div>

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
                <h2 className="text-sm font-semibold text-gray-900 mb-1.5">
                  {t.projects.members} ({p._count.relations})
                </h2>
                {p.relations.length === 0 ? (
                  <p className="text-sm text-gray-400">{t.projects.noMembers}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {p.relations.map((r) => (
                      <span key={r.mentee.id} className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 text-sm">
                        {r.mentee.fullName}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {p.tasks.length > 0 && (
                <div>
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>{done}/{p.tasks.length} {t.projects.tasksDone}</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-2">
                    <div className="h-full bg-green-500" style={{ width: `${pct}%` }} />
                  </div>
                  <ul className="space-y-1">
                    {p.tasks.map((tk) => (
                      <li key={tk.id} className="flex items-center gap-2 text-sm">
                        {tk.done
                          ? <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                          : <Circle className="h-4 w-4 text-gray-300 flex-shrink-0" />}
                        <span className={tk.done ? 'line-through text-gray-400' : 'text-gray-700'}>{tk.title}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-400 mt-6">{p._count.relations} {t.projects.members}</p>
          )}
        </div>
      </div>
    </div>
  );
}
