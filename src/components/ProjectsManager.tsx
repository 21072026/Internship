'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Github, ExternalLink, Trash2, Pencil, Trello, Plus, Eye, Users2 } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDate, durationSince } from '@/lib/relativeTime';

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
  ownerType: 'ADMIN' | 'MENTOR' | 'COMPANY';
  ownerUser?: { id: string; fullName: string } | null;
  ownerCompany?: { id: string; name: string } | null;
  tasks?: Task[];
  relations?: { mentee: { id: string; fullName: string } }[];
  members?: { role: 'OWNER' | 'MENTOR' | 'MENTEE'; functionalRole?: 'DEVELOPER' | 'TESTER' | 'MARKETING' | null; addedAt?: string; user: { id: string; fullName: string; role: string } }[];
  _count?: { relations: number };
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
  const [mentors, setMentors] = useState<{ id: string; fullName: string }[]>([]);
  const [mentees, setMentees] = useState<{ id: string; fullName: string }[]>([]);
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [ownerType, setOwnerType] = useState('ADMIN');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [ownerCompanyId, setOwnerCompanyId] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/projects');
    const d = await res.json();
    setProjects(d.projects ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // Mentors get a minimal directory too — needed for the member picker (#618).
    fetch('/api/users').then((r) => (r.ok ? r.json() : { users: [] }))
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

  const remove = async (p: Project) => {
    if (!window.confirm(t.projects.confirmDelete.replace('{name}', p.name))) return;
    await fetch(`/api/projects/${p.id}`, { method: 'DELETE' });
    await load();
  };

  const [taskDraft, setTaskDraft] = useState<Record<string, string>>({});
  const addTask = async (projectId: string) => {
    const title = (taskDraft[projectId] ?? '').trim();
    if (!title) return;
    await fetch(`/api/projects/${projectId}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    });
    setTaskDraft((p) => ({ ...p, [projectId]: '' }));
    await load();
  };
  const toggleTask = async (task: Task) => {
    await fetch(`/api/project-tasks/${task.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: !task.done }),
    });
    await load();
  };
  const deleteTask = async (task: Task) => {
    if (!window.confirm(t.projects.confirmDeleteTask.replace('{title}', task.title))) return;
    await fetch(`/api/project-tasks/${task.id}`, { method: 'DELETE' });
    await load();
  };

  const ownerLabel = (p: Project) =>
    p.ownerType === 'COMPANY' ? p.ownerCompany?.name : p.ownerUser?.fullName;

  // Owner management + transfer (#618) on top of /api/projects/[id]/members.
  const [manageId, setManageId] = useState<string | null>(null);
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<'OWNER' | 'MENTOR'>('MENTOR');
  // Mentee members (#51): a separate picker so a mentee can be added with a
  // functional (job) role, kept distinct from the owner/mentor management row.
  const [addMenteeId, setAddMenteeId] = useState('');
  const [addFunc, setAddFunc] = useState<'DEVELOPER' | 'TESTER' | 'MARKETING'>('DEVELOPER');
  const [memberErr, setMemberErr] = useState('');
  const canManageMembers = (p: Project) =>
    isAdmin || (p.members ?? []).some((m) => m.user.id === meId && m.role === 'OWNER');
  // Owner-only fields (#619): non-owner mentor members get a limited form.
  const isOwnerOf = (p: Project) =>
    isAdmin || p.ownerUser?.id === meId || (p.members ?? []).some((m) => m.user.id === meId && m.role === 'OWNER');
  const [editingOwner, setEditingOwner] = useState(true);

  const memberCall = async (projectId: string, method: 'POST' | 'DELETE', body: Record<string, unknown>) => {
    setMemberErr('');
    const res = await fetch(`/api/projects/${projectId}/members`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setMemberErr(d.code === 'last_owner' ? t.projects.lastOwnerError : d.error || t.common.error);
      return false;
    }
    await load();
    return true;
  };

  const addMember = (projectId: string) => {
    if (!addUserId) return;
    memberCall(projectId, 'POST', { userId: addUserId, role: addRole }).then((ok) => { if (ok) setAddUserId(''); });
  };
  const addMenteeMember = (projectId: string) => {
    if (!addMenteeId) return;
    memberCall(projectId, 'POST', { userId: addMenteeId, role: 'MENTEE', functionalRole: addFunc }).then((ok) => { if (ok) setAddMenteeId(''); });
  };
  // Transfer = make the target an OWNER, then step down yourself.
  const transferTo = async (projectId: string) => {
    if (!addUserId) return;
    if (await memberCall(projectId, 'POST', { userId: addUserId, role: 'OWNER' })) {
      await memberCall(projectId, 'DELETE', { userId: meId });
    }
  };

  return (
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
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3} className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm" />
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
            <textarea value={form.goals} onChange={(e) => setForm({ ...form, goals: e.target.value })}
              rows={2} className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm" />
          </div>

          {isAdmin && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-gray-100 pt-3">
              {editingId && <p className="sm:col-span-2 text-xs text-gray-500">{t.projects.transferHint}</p>}
              <Select label={t.projects.owner} value={ownerType} onChange={(e) => { setOwnerType(e.target.value); setOwnerUserId(''); setOwnerCompanyId(''); }}
                options={[{ value: 'ADMIN', label: t.projects.ownerAdmin }, { value: 'MENTOR', label: t.projects.ownerMentor }, { value: 'COMPANY', label: t.projects.ownerCompany }]} />
              {ownerType === 'MENTOR' && (
                <Select label={t.projects.ownerMentor} value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}
                  options={[{ value: '', label: '—' }, ...mentors.map((m) => ({ value: m.id, label: m.fullName }))]} />
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

      <h2 className="text-sm font-medium text-gray-500 mb-3">{t.projects.allProjects} ({projects.length})</h2>
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
                      {t.projects.owner}: {ownerLabel(p)} · {p._count?.relations ?? 0} {t.projects.members}
                    </p>
                    {(p.relations?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5" data-testid="project-members">
                        {p.relations!.slice(0, 6).map((r) => (
                          <span key={r.mentee.id} className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-xs">
                            {r.mentee.fullName}
                          </span>
                        ))}
                        {(p._count?.relations ?? 0) > 6 && (
                          <span className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 text-xs">
                            +{(p._count?.relations ?? 0) - 6}
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
                      {(p.startDate || p.endDate) && (
                        <span className="text-gray-400">
                          {p.startDate ? formatDate(p.startDate, locale) : '…'} – {p.endDate ? formatDate(p.endDate, locale) : '…'}
                        </span>
                      )}
                    </div>

                    {/* Tasks + progress */}
                    {(() => {
                      const tasks = p.tasks ?? [];
                      const done = tasks.filter((tk) => tk.done).length;
                      const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
                      return (
                        <div className="mt-3 max-w-md">
                          {tasks.length > 0 && (
                            <>
                              <div className="flex justify-between text-xs text-gray-500 mb-1">
                                <span>{done}/{tasks.length} {t.projects.tasksDone}</span>
                                <span>{pct}%</span>
                              </div>
                              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-2">
                                <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
                              </div>
                              <div className="space-y-1">
                                {tasks.map((tk) => (
                                  <div key={tk.id} data-testid={`task-${tk.id}`} className="flex items-center gap-2 text-sm">
                                    <input type="checkbox" checked={tk.done} onChange={() => toggleTask(tk)} />
                                    <span className={`flex-1 ${tk.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>{tk.title}</span>
                                    <button onClick={() => deleteTask(tk)} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                          <div className="flex gap-2 mt-2">
                            <input
                              value={taskDraft[p.id] ?? ''}
                              onChange={(e) => setTaskDraft((prev) => ({ ...prev, [p.id]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTask(p.id); } }}
                              placeholder={t.projects.addTask}
                              className="flex-1 rounded-lg border border-gray-300 px-2.5 py-1 text-sm"
                            />
                            <Button type="button" size="sm" variant="outline" onClick={() => addTask(p.id)}>{t.projects.add}</Button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    {canManageMembers(p) && (
                      <button onClick={() => { setManageId(manageId === p.id ? null : p.id); setAddUserId(''); setMemberErr(''); }} aria-label={t.projects.manageOwners} data-testid="manage-owners" className="p-2 text-gray-400 hover:text-blue-600"><Users2 className="h-4 w-4" /></button>
                    )}
                    <button onClick={() => edit(p)} aria-label={t.projects.editProject} className="p-2 text-gray-400 hover:text-blue-600"><Pencil className="h-4 w-4" /></button>
                    {isOwnerOf(p) && (
                      <button onClick={() => remove(p)} aria-label={t.projects.deleteProject} className="p-2 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    )}
                  </div>
                </div>

                {manageId === p.id && (
                  <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800" data-testid="owners-panel">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">{t.projects.manageOwners}</p>
                    {memberErr && <p className="text-xs text-red-600 mb-2">{memberErr}</p>}
                    <div className="space-y-1 mb-3">
                      {(p.members ?? []).map((m) => (
                        <div key={m.user.id} className="flex items-center gap-2 text-sm">
                          <Badge variant={m.role === 'OWNER' ? 'info' : m.role === 'MENTEE' ? 'purple' : 'default'} className="text-xs">
                            {m.role === 'OWNER' ? t.projects.roleOwner : m.role === 'MENTEE' ? t.projects.roleMentee : t.projects.roleMentorMember}
                          </Badge>
                          {m.role === 'MENTEE' && m.functionalRole && (
                            <Badge variant="default" className="text-xs">
                              {(t.projects.functionalRoles as Record<string, string>)[m.functionalRole]}
                            </Badge>
                          )}
                          <span className="flex-1 text-gray-800 dark:text-gray-200">
                            {m.user.fullName}
                            {m.addedAt && (() => {
                              const { count, unit } = durationSince(m.addedAt);
                              const noun = count === 1 ? t.membership[unit] : t.membership[`${unit}s` as 'days' | 'months' | 'years'];
                              return <span className="ml-1.5 text-xs text-gray-400">· {t.membership.inProjectFor.replace('{d}', `${count} ${noun}`)}</span>;
                            })()}
                          </span>
                          <button onClick={() => memberCall(p.id, 'DELETE', { userId: m.user.id })} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2 flex-wrap items-center">
                      <select value={addUserId} onChange={(e) => setAddUserId(e.target.value)} data-testid="member-picker"
                        className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-sm">
                        <option value="">—</option>
                        {mentors.filter((m) => !(p.members ?? []).some((x) => x.user.id === m.id)).map((m) => (
                          <option key={m.id} value={m.id}>{m.fullName}</option>
                        ))}
                      </select>
                      <select value={addRole} onChange={(e) => setAddRole(e.target.value as 'OWNER' | 'MENTOR')}
                        className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-sm">
                        <option value="MENTOR">{t.projects.roleMentorMember}</option>
                        <option value="OWNER">{t.projects.roleOwner}</option>
                      </select>
                      <Button type="button" size="sm" variant="outline" disabled={!addUserId} onClick={() => addMember(p.id)} data-testid="member-add">
                        {t.projects.add}
                      </Button>
                      {(p.members ?? []).some((m) => m.user.id === meId && m.role === 'OWNER') && (
                        <Button type="button" size="sm" variant="secondary" disabled={!addUserId} onClick={() => transferTo(p.id)} data-testid="member-transfer">
                          {t.projects.transfer}
                        </Button>
                      )}
                    </div>

                    {/* Mentee members with a functional (job) role (#51). */}
                    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                      <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">{t.projects.addMenteeMember}</p>
                      <div className="flex gap-2 flex-wrap items-center">
                        <select value={addMenteeId} onChange={(e) => setAddMenteeId(e.target.value)} data-testid="mentee-picker"
                          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-sm">
                          <option value="">—</option>
                          {mentees.filter((m) => !(p.members ?? []).some((x) => x.user.id === m.id)).map((m) => (
                            <option key={m.id} value={m.id}>{m.fullName}</option>
                          ))}
                        </select>
                        <select value={addFunc} onChange={(e) => setAddFunc(e.target.value as 'DEVELOPER' | 'TESTER' | 'MARKETING')} data-testid="functional-role-picker"
                          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-sm">
                          {(['DEVELOPER', 'TESTER', 'MARKETING'] as const).map((fr) => (
                            <option key={fr} value={fr}>{(t.projects.functionalRoles as Record<string, string>)[fr]}</option>
                          ))}
                        </select>
                        <Button type="button" size="sm" variant="outline" disabled={!addMenteeId} onClick={() => addMenteeMember(p.id)} data-testid="mentee-add">
                          {t.projects.add}
                        </Button>
                      </div>
                      {mentees.length === 0 && (
                        <p className="text-xs text-gray-400 mt-1.5">{t.projects.noMenteesToAdd}</p>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
    </div>
  );
}
