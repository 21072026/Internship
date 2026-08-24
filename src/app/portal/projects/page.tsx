import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { FolderKanban, Github, ExternalLink, Trello, Users2, ArrowRight } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { loadMenteeProjects } from '@/lib/menteeProjects';
import { hasAcceptedContributorTerms } from '@/lib/contributorTerms';
import { ContributorTermsGate } from '@/components/ContributorTermsGate';

export const dynamic = 'force-dynamic';

const STATUS_VARIANT: Record<string, 'success' | 'info' | 'default' | 'warning'> = {
  DRAFT: 'warning', ACTIVE: 'success', COMPLETED: 'info', ARCHIVED: 'default', CANCELLED: 'default',
};

// The mentee's own project list (#1114). `/projects` is the *public* showcase, so
// before this page a mentee assigned to a private project had no link to it
// anywhere in the portal — see the note in lib/menteeProjects.ts.
export default async function PortalProjectsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');

  const { t } = await getServerDictionary();

  // The one contributor-facing surface in the portal (#1025). Project work is
  // where authored material — and with it the IP question — comes from, so this
  // is the page the platform-level contributor terms gate belongs in front of.
  // The rest of the portal stays open on purpose: the terms are about
  // contributions, not about being a mentee.
  if (!(await hasAcceptedContributorTerms(session.user.id))) {
    return (
      <div className="py-6">
        <ContributorTermsGate
          title={t.contributorTerms.gateTitle}
          body={t.contributorTerms.gateBody}
          cta={t.contributorTerms.gateCta}
          next="/portal/projects"
        />
      </div>
    );
  }

  const projects = await loadMenteeProjects(session.user.id);

  const statusLabel = (s: string) =>
    ({
      ACTIVE: t.projects.active,
      COMPLETED: t.projects.completed,
      ARCHIVED: t.projects.archived,
      DRAFT: t.projects.draft,
      CANCELLED: t.projects.cancelled,
    })[s] ?? s;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.portal.projects.title}</h1>
        <p className="text-gray-500 mt-1">{t.portal.projects.subtitle}</p>
      </div>

      {projects.length === 0 ? (
        <Card className="text-center py-12" data-testid="portal-projects-empty">
          <div className="w-16 h-16 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-4">
            <FolderKanban className="h-8 w-8 text-gray-400" />
          </div>
          <p className="text-gray-500 font-medium">{t.portal.projects.none}</p>
          <p className="text-sm text-gray-400 mt-1">{t.portal.projects.noneHint}</p>
          {/* A mentee with no project can still find (and ask to join) a public
              one — the showcase accepts join requests from signed-in mentees. */}
          <Link
            href="/projects"
            className="mt-4 inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
          >
            {t.portal.projects.browseShowcase}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" data-testid="portal-projects-list">
          {projects.map((p) => (
            <Card key={p.id} data-testid={`portal-project-card-${p.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/projects/${p.id}`}
                    className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600"
                  >
                    {p.name}
                  </Link>
                  {p.owner && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {t.projects.by} {p.owner}
                    </p>
                  )}
                </div>
                <Badge variant={STATUS_VARIANT[p.status] ?? 'default'}>{statusLabel(p.status)}</Badge>
              </div>

              {p.description && (
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-3 line-clamp-3">{p.description}</p>
              )}

              {p.technologies.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {p.technologies.map((x) => (
                    <span key={x} className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs">
                      {x}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-4 text-xs">
                <span className="inline-flex items-center gap-1 text-gray-500">
                  <Users2 className="h-3.5 w-3.5" />
                  {p.internCount} {t.projects.members}
                </span>
                {p.repoUrl && (
                  <a href={p.repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-600 hover:text-blue-600">
                    <Github className="h-3.5 w-3.5" />
                    {t.projects.repo}
                  </a>
                )}
                {p.demoUrl && (
                  <a href={p.demoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-600 hover:text-blue-600">
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t.projects.demo}
                  </a>
                )}
                {p.boardUrl && (
                  <a href={p.boardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-600 hover:text-blue-600">
                    <Trello className="h-3.5 w-3.5" />
                    {t.projects.board}
                  </a>
                )}
                <Link
                  href={`/projects/${p.id}`}
                  className="ml-auto inline-flex items-center gap-1 text-blue-600 hover:underline"
                  data-testid="portal-project-detail-link"
                >
                  {t.projects.viewDetail}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
