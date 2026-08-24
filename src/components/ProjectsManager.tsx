'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Github, ExternalLink, Trash2, Pencil, Trello, Plus, Eye, Users2, Inbox } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import type { TeamMember } from '@/lib/projectTeam';
import { PersonHoverCard } from '@/components/PersonHoverCard';

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
const blank = { name: '', description: '', technologies: '', repoUrl: '', demoUrl: '', boardUrl: '', status: 'ACTIVE', isPublic: false, goals: '', startDate: '', endDate: '' };

export function ProjectsManager({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ ...blank });
  const [editingId, setEditingId] = useState<string | null>(null);
  // Card-first screen (#615): the create/edit form lives in a panel that only
  // opens via "Add project" or a card's edit action.
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Only the owner picker needs a directory here now; the member pickers moved
  // to the project page with the panel.
  const [mentors, setMentors] = useState<{ id: string; fullName: string }[]>([]);
  const [mentees, setMentees] = useState<{ id: string; fullName: string }[]>([]);
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [ownerType, setOwnerType] = useState('ADMIN');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [ownerCompanyId, setOwnerCompanyId] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/projects');
    const d = await res.json();
    setProjects(d.projects ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch('/api/users?view=picker').then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => {
        const users = (d.users ?? []) as { id: string; fullName: string; role: string }[];
        setMentors(users.filter((u) => u.role === 'MENTOR' || u.role === 'ADMIN'));
        setMentees(users.filter((u) => u.role === 'MENTEE'));
      })
      .catch(() => {});
    if (!isAdmin) return;
    fetch('/api/companies').then((r) => r.json()).then((d) => setCompanies(d.companies ?? []));
  }, [isAdmin]);

  const reset = () => { setForm({ ...blank }); setEditingId(null); setEditingOwner(true); setOwnerType('ADMIN'); setOwnerUserId(''); setOwnerCompanyId(''); setShowForm(false); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const payload: Record<string, unknown> = {
        description: form.description,
        technologies: form.technologies.split(',').map((s) => s.trim()).filter(Boolean),
        repoUrl: form.repoUrl,
        demoUrl: form.demoUrl,
        boardUrl: form.boardUrl,
        goals: form.goals,
      };
      // Owner-protected fields (#619) — the server rejects them from
      // non-owners, so a limited editor simply doesn't send them.
      if (editingOwner || !editingId) {
        Object.assign(payload, {
          name: form.name,
          status: form.status,
          isPublic: form.isPublic,
          startDate: form.startDate || null,
          endDate: form.endDate || null,
        });
      }
      // Admin sets/changes ownership (create or transfer-on-edit), preserving
      // the "exactly one owner" invariant.
      if (isAdmin) {
        payload.ownerType = ownerType;
        // ADMIN ownership is always the acting admin (no admin picker in this UI);
        // using a stale ownerUserId from a previous MENTOR owner would fail
        // server validation ("Invalid owner").
        if (ownerType === 'COMPANY') payload.ownerCompanyId = ownerCompanyId;
        else if (ownerType === 'MENTOR') payload.ownerUserId = ownerUserId;
        else if (ownerType === 'MENTEE') payload.ownerUserId = ownerUserId;
        else payload.ownerUserId = meId; // ADMIN → acting admin
      }
      const url = editingId ? `/api/projects/${editingId}` : '/api/projects';
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      reset();
      await load();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const [meId, setMeId] = useState('');
  useEffect(() => { fetch('/api/profile').then((r) => r.json()).then(({ user }) => user && setMeId(user.id)); }, []);

  const edit = (p: Project) => {
    setShowForm(true);
    setEditingId(p.id);
    setEditingOwner(isOwnerOf(p));
    setForm({
      name: p.name, description: p.description ?? '', technologies: p.technologies.join(', '),
      repoUrl: p.repoUrl ?? '', demoUrl: p.demoUrl ?? '', boardUrl: p.boardUrl ?? '', status: p.status, isPublic: p.isPublic,
      goals: p.goals ?? '', startDate: p.startDate ? p.startDate.slice(0, 10) : '', endDate: p.endDate ? p.endDate.slice(0, 10) : '',
    });
    setOwnerType(p.ownerType);
    setOwnerUserId(p.ownerUser?.id ?? '');
    setOwnerCompanyId(p.ownerCompany?.id ?? '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
  const [editingOwner, setEditingOwner] = useState(true);

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
      <Card className="mb-6 max-w-3xl">
        <CardHeader><CardTitle>{editingId ? t.projects.editProject : t.projects.newProject}</CardTitle></CardHeader>
        {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
        <form onSubmit={submit} className="space-y-3">
          <Input label={t.projects.name} required disabled={!editingOwner && !!editingId} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          {!editingOwner && !!editingId && <p className="text-xs text-gray-400 -mt-2">{t.projects.ownerOnlyHint}</p>}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.projects.description}</label>
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3} maxLength={5000} showCounter />
          </div>
          <Input label={t.projects.technologies} hint={t.projects.techHint} value={form.technologies} onChange={(e) => setForm({ ...form, technologies: e.target.value })} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label={t.projects.repoUrl} type="url" placeholder="https://github.com/..." value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} />
            <Input label={t.projects.demoUrl} type="url" placeholder="https://..." value={form.demoUrl} onChange={(e) => setForm({ ...form, demoUrl: e.target.value })} />
            <Input label={t.projects.boardUrl} type="url" placeholder="https://github.com/users/you/projects/2" hint={t.projects.boardUrlHint} value={form.boardUrl} onChange={(e) => setForm({ ...form, boardUrl: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select label={t.projects.status} disabled={!editingOwner && !!editingId} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
              options={[
                { value: 'DRAFT', label: t.projects.draft },
                { value: 'ACTIVE', label: t.projects.active },
                { value: 'COMPLETED', label: t.projects.completed },
                { value: 'ARCHIVED', label: t.projects.archived },
                { value: 'CANCELLED', label: t.projects.cancelled },
              ]} />
            <label className="flex items-center gap-2 text-sm text-gray-700 mt-7">
              <input type="checkbox" disabled={!editingOwner && !!editingId} checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} />
              {t.projects.isPublic}
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label={t.projects.startDate} type="date" disabled={!editingOwner && !!editingId} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            <Input label={t.projects.endDate} type="date" disabled={!editingOwner && !!editingId} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.projects.goals}</label>
            <Textarea value={form.goals} onChange={(e) => setForm({ ...form, goals: e.target.value })}
              rows={2} maxLength={5000} showCounter />
          </div>

          {isAdmin && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-gray-100 pt-3">
              {editingId && <p className="sm:col-span-2 text-xs text-gray-500">{t.projects.transferHint}</p>}
              <Select label={t.projects.owner} value={ownerType} onChange={(e) => { setOwnerType(e.target.value); setOwnerUserId(''); setOwnerCompanyId(''); }}
                options={[{ value: 'ADMIN', label: t.projects.ownerAdmin }, { value: 'MENTOR', label: t.projects.ownerMentor }, { value: 'MENTEE', label: t.projects.ownerMentee }, { value: 'COMPANY', label: t.projects.ownerCompany }]} />
              {ownerType === 'MENTOR' && (
                <Select label={t.projects.ownerMentor} value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}
                  options={[{ value: '', label: '—' }, ...mentors.map((m) => ({ value: m.id, label: m.fullName }))]} />
              )}
              {ownerType === 'MENTEE' && (
                <Select label={t.projects.ownerMentee} value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}
                  options={[{ value: '', label: '—' }, ...mentees.map((m) => ({ value: m.id, label: m.fullName }))]} />
              )}
              {ownerType === 'COMPANY' && (
                <Select label={t.projects.ownerCompany} value={ownerCompanyId} onChange={(e) => setOwnerCompanyId(e.target.value)}
                  options={[{ value: '', label: '—' }, ...companies.map((c) => ({ value: c.id, label: c.name }))]} />
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button type="submit" loading={saving}>{editingId ? t.projects.save : t.projects.create}</Button>
            <Button type="button" variant="outline" onClick={reset}>{t.common.cancel}</Button>
          </div>
        </form>
      </Card>
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
                    <button onClick={() => edit(p)} aria-label={t.projects.editProject} className="p-2 text-gray-400 hover:text-blue-600"><Pencil className="h-4 w-4" /></button>
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
