import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { Github, ExternalLink, ArrowLeft } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { roleHome } from '@/lib/roleHome';

export const dynamic = 'force-dynamic';

// Public showcase of community/company projects opted into visibility.
export default async function PublicProjectsPage() {
  const { t } = await getServerDictionary();
  const session = (await hasSessionCookie()) ? await getServerSession(authOptions) : null;
  // Signed-in visitors arrive here from inside the app (e.g. "Browse the project
  // showcase" on /portal/projects), but this route lives outside the role shell,
  // so there is no sidebar to walk back through — send them to their own
  // dashboard. Anonymous visitors get the landing page. Same shape as the
  // project detail page (#51 follow-up, #1159).
  const backHref = session ? roleHome(session.user.role) : '/';
  const backLabel = session ? t.projects.backDashboard : t.projects.backHome;
  const projects = await prisma.project.findMany({
    where: { isPublic: true },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true, name: true, description: true, technologies: true, repoUrl: true, demoUrl: true,
      ownerType: true, ownerUser: { select: { fullName: true } }, ownerCompany: { select: { name: true } },
    },
  });

  return (
    <PublicShell>
      <div className="max-w-5xl mx-auto px-4 py-12">
        <Link
          href={backHref}
          data-testid="showcase-back"
          className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6"
        >
          <ArrowLeft className="h-4 w-4" /> {backLabel}
        </Link>
        <h1 className="text-3xl font-bold text-gray-900">{t.projects.showcaseTitle}</h1>
        <p className="text-gray-500 mt-2 mb-8">{t.projects.showcaseSubtitle}</p>
        {projects.length === 0 ? (
          <div>
            <p className="text-gray-400">{t.projects.noPublic}</p>
            <p className="text-sm text-gray-500 mt-2">{t.projects.noPublicHint}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {projects.map((p) => {
              const tech = Array.isArray(p.technologies) ? (p.technologies as string[]) : [];
              const owner = p.ownerType === 'COMPANY' ? p.ownerCompany?.name : p.ownerUser?.fullName;
              return (
                <div key={p.id} className="bg-white rounded-2xl border border-gray-100 p-6 hover:shadow-lg transition-shadow">
                  <Link href={`/projects/${p.id}`} className="text-lg font-semibold text-gray-900 hover:text-blue-600">{p.name}</Link>
                  {owner && <p className="text-xs text-gray-500 mt-0.5">{t.projects.by} {owner}</p>}
                  {p.description && <p className="text-sm text-gray-600 mt-2 line-clamp-3">{p.description}</p>}
                  <div className="flex flex-wrap gap-1 mt-3">
                    {tech.map((x) => <span key={x} className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs">{x}</span>)}
                  </div>
                  <div className="flex gap-3 mt-3 text-xs">
                    {p.repoUrl && <a href={p.repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-600 hover:text-blue-600"><Github className="h-3.5 w-3.5" />{t.projects.repo}</a>}
                    {p.demoUrl && <a href={p.demoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-600 hover:text-blue-600"><ExternalLink className="h-3.5 w-3.5" />{t.projects.demo}</a>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PublicShell>
  );
}
