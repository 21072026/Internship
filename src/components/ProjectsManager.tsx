'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Github, ExternalLink, Trash2, Pencil, Trello, Plus, Eye, Users2, Inbox } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import type { TeamMember } from '@/lib/projectTeam';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import { ProjectForm } from '@/components/project/ProjectForm';
import { scrollBehavior } from '@/lib/motion';

interface Task {
  id: string;
  title: string;
  done: boolean;
}
type ProjectStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED' | 'CANCELLED';
interface Project {
  id: string;
  name: string;
  description: string | null;
  technologies: string[];
  repoUrl: string | null;
  demoUrl: string | null;
  boardUrl: string | null;
  status: ProjectStatus;
  isPublic: boolean;
  goals: string | null;
  startDate: string | null;
  endDate: string | null;
  contributorTermsKey?: string | null;
  contributorTermsRequired?: boolean;
  ownerType: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY';
  ownerUser?: { id: string; fullName: string } | null;
  ownerCompany?: { id: string; name: string } | null;
  tasks?: Task[];
  relations?: { mentee: { id: string; fullName: string } }[];
  members?: { role: 'OWNER' | 'MENTOR' | 'MENTEE'; functionalRole?: 'DEVELOPER' | 'TESTER' | 'MARKETING' | null; addedAt?: string; user: { id: string; fullName: string; role: string } }[];
  // Merged roster (members + legacy relations) served by /api/projects (#51).
  team?: TeamMember[];
  internCount?: number;
  _count?: { relations: number; joinRequests?: number };
}

const STATUS_VARIANT: Record<ProjectStatus, 'success' | 'info' | 'default' | 'warning'> = {
  DRAFT: 'warning', ACTIVE: 'success', COMPLETED: 'info', ARCHIVED: 'default', CANCELLED: 'default',
};

export function ProjectsManager({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  // Card-first screen (#615): the create/edit form lives in a panel that only
  // opens via "Add project" or a card's edit action. The form itself is shared
  // with the portal now (#2270) — see components/project/ProjectForm.tsx.
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/projects');
    const d = await res.json();
    setProjects(d.projects ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const reset = () => { setEditing(null); setShowForm(false); };

  const [meId, setMeId] = useState('');
  useEffect(() => { fetch('/api/profile').then((r) => r.json()).then(({ user }) => user && setMeId(user.id)); }, []);

  const edit = (p: Project) => {
    setEditing(p);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  };

  const remove = (p: Project) => setPendingDelete({ id: p.id, name: p.name });

  const confirmRemove = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await fetch(`/api/projects/${pendingDelete.id}`, { method: 'DELETE' });
      await load();
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const ownerLabel = (p: Project) =>
    p.ownerType === 'COMPANY' ? p.ownerCompany?.name : p.ownerUser?.fullName;

  // What to print next to a team member's name: the job they do when we know it
  // (developer/tester/…), otherwise their structural role.
  const roleLabel = (m: TeamMember) =>
    m.role === 'MENTEE'
      ? m.functionalRole
        ? (t.projects.functionalRoles as Record<string, string>)[m.functionalRole]
        : t.projects.roleMentee
      : m.role === 'OWNER'
        ? t.projects.roleOwner
        : t.projects.roleMentorMember;

  // Who may open the project's member management (now on the project page).
  const canManageMembers = (p: Project) =>
    isAdmin || (p.members ?? []).some((m) => m.user.id === meId && m.role === 'OWNER');
  // Owner-only fields (#619): non-owner mentor members get a limited form.
  const isOwnerOf = (p: Project) =>
    isAdmin || p.ownerUser?.id === meId || (p.members ?? []).some((m) => m.user.id === meId && m.role === 'OWNER');
  // The pencil used to render on every card. Harmless while this screen was
  // admin/mentor-only (their list is what they own or are on), but the form it
  // opens saves through an API that answers 403 to a stranger — so it is gated
  // on the same test the server applies: owner, or a member of the project.
  const canEdit = (p: Project) => isOwnerOf(p) || (p.members ?? []).some((m) => m.user.id === meId);

  return (
    <>
    <div>
      <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.projects.title}</h1>
          <p className="text-gray-500 mt-1">{t.projects.subtitle}</p>
        </div>
        {!showForm && (
          <Button type="button" onClick={() => { reset(); setShowForm(true); }} data-testid="add-project">
            <Plus className="h-4 w-4 mr-1" /> {t.projects.newProject}
          </Button>
        )}
      </div>

      {showForm && (
        <ProjectForm
          // Remount when the edit target changes (#2270). `edit(p)` only sets
          // `editing`/`showForm`, and the cards stay rendered below the open
          // form — so clicking a second pencil kept the same ProjectForm
          // instance, whose field state is seeded once from the prop. The
          // header said "Edit project" for B while every input still held A,
          // and Save wrote A's values (owner included) onto B.
          key={editing?.id ?? 'new'}
          project={editing}
          canEditProtected={!editing || isOwnerOf(editing)}
          showOwnerPicker={isAdmin}
          showTermsPicker
          meId={meId}
          onSaved={async () => { reset(); await load(); }}
          onCancel={reset}
        />
      )}

      <h2 className="text-sm font-medium text-gray-500 mb-3">{t.projects.allProjects} {loading ? '' : `(${projects.length})`}</h2>
      {loading ? (
        <p className="text-center py-10 text-gray-400">{t.common.loading}</p>
      ) : projects.length === 0 ? (
        <Card><p className="text-center py-10 text-gray-400">{t.projects.none}</p></Card>
      ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {projects.map((p) => (
              <Card key={p.id} data-testid="project-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-900">{p.name}</span>
                      <Badge variant={STATUS_VARIANT[p.status]}>{t.projects[p.status.toLowerCase() as 'draft' | 'active' | 'completed' | 'archived' | 'cancelled']}</Badge>
                      {p.isPublic && <Badge variant="purple">{t.projects.public}</Badge>}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {t.projects.owner}: {ownerLabel(p)} · {p.internCount ?? 0} {t.projects.members}
                    </p>
                    {/* The roster, from the merged team (#51) — the chips used to
                        come from legacy MentorshipRelation rows only, so people
                        added through the member panel never showed up. */}
                    {(p.team?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5" data-testid="project-members">
                        {p.team!.slice(0, 8).map((m) => (
                          <span key={m.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-xs">
                            <PersonHoverCard personId={m.id} name={m.fullName} />
                            <span className="text-gray-400">· {roleLabel(m)}</span>
                          </span>
                        ))}
                        {p.team!.length > 8 && (
                          <span className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 text-xs">
                            +{p.team!.length - 8}
                          </span>
                        )}
                      </div>
                    )}
                    {p.description && <p className="text-sm text-gray-600 mt-1 line-clamp-2">{p.description}</p>}
                    <div className="flex flex-wrap gap-1 mt-2">
                      {p.technologies.map((tech) => (
                        <span key={tech} className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs">{tech}</span>
                      ))}
                    </div>
                    <div className="flex gap-3 mt-2 text-xs">
                      {p.repoUrl && <a href={p.repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-600 hover:text-blue-600"><Github className="h-3.5 w-3.5" />{t.projects.repo}</a>}
                      {p.demoUrl && <a href={p.demoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-600 hover:text-blue-600"><ExternalLink className="h-3.5 w-3.5" />{t.projects.demo}</a>}
                      {p.boardUrl && <a href={p.boardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-600 hover:text-blue-600"><Trello className="h-3.5 w-3.5" />{t.projects.board}</a>}
                      <a href={`/projects/${p.id}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline" data-testid="project-detail-link"><Eye className="h-3.5 w-3.5" />{t.projects.viewDetail}</a>
                      {(p._count?.joinRequests ?? 0) > 0 && (
                        <a href={`/projects/${p.id}`} className="inline-flex items-center gap-1 text-amber-600 hover:underline" data-testid="pending-join-requests">
                          <Inbox className="h-3.5 w-3.5" />{t.projects.joinRequests} ({p._count!.joinRequests})
                        </a>
                      )}
                      {(p.startDate || p.endDate) && (
                        <span className="text-gray-400">
                          {p.startDate ? formatDate(p.startDate, locale) : '…'} – {p.endDate ? formatDate(p.endDate, locale) : '…'}
                        </span>
                      )}
                    </div>

                    {/* Progress only. The editable checklist that used to live
                        here moved to the project page (#51): goals now belong to
                        a person, and having them in two places meant a card and a
                        detail view that disagreed — plus, on a phone, an "add a
                        task" box squeezed to a few pixels. */}
                    {(p.tasks?.length ?? 0) > 0 && (() => {
                      const tasks = p.tasks!;
                      const done = tasks.filter((tk) => tk.done).length;
                      const pct = Math.round((done / tasks.length) * 100);
                      return (
                        <div className="mt-3 max-w-md">
                          <div className="flex justify-between text-xs text-gray-500 mb-1">
                            <span>{done}/{tasks.length} {t.projects.tasksDone}</span>
                            <span>{pct}%</span>
                          </div>
                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    {canManageMembers(p) && (
                      <a href={`/projects/${p.id}`} aria-label={t.projects.manageOwners} data-testid="manage-owners" className="p-2 text-gray-400 hover:text-blue-600"><Users2 className="h-4 w-4" /></a>
                    )}
                    {canEdit(p) && (
                      <button onClick={() => edit(p)} aria-label={t.projects.editProject} className="p-2 text-gray-400 hover:text-blue-600"><Pencil className="h-4 w-4" /></button>
                    )}
                    {isOwnerOf(p) && (
                      <button onClick={() => remove(p)} aria-label={t.projects.deleteProject} className="p-2 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    )}
                  </div>
                </div>

              </Card>
            ))}
          </div>
        )}
    </div>
    <ConfirmDialog
      open={pendingDelete !== null}
      message={pendingDelete ? t.projects.confirmDelete.replace('{name}', pendingDelete.name) : ''}
      cancelLabel={t.common.cancel}
      confirmLabel={t.common.delete}
      variant="danger"
      loading={deleting}
      onConfirm={confirmRemove}
      onCancel={() => setPendingDelete(null)}
    />
    </>
  );
}
