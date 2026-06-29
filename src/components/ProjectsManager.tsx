'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Github, ExternalLink, Trash2, Pencil } from 'lucide-react';
import { useT } from '@/i18n/client';

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
  status: ProjectStatus;
  isPublic: boolean;
  goals: string | null;
  startDate: string | null;
  endDate: string | null;
  ownerType: 'ADMIN' | 'MENTOR' | 'COMPANY';
  ownerUser?: { id: string; fullName: string } | null;
  ownerCompany?: { id: string; name: string } | null;
  tasks?: Task[];
  _count?: { relations: number };
}

const STATUS_VARIANT: Record<ProjectStatus, 'success' | 'info' | 'default' | 'warning'> = {
  DRAFT: 'warning', ACTIVE: 'success', COMPLETED: 'info', ARCHIVED: 'default', CANCELLED: 'default',
};
const blank = { name: '', description: '', technologies: '', repoUrl: '', demoUrl: '', status: 'ACTIVE', isPublic: false, goals: '', startDate: '', endDate: '' };

export function ProjectsManager({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ ...blank });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [mentors, setMentors] = useState<{ id: string; fullName: string }[]>([]);
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
    if (!isAdmin) return;
    fetch('/api/users').then((r) => r.json()).then((d) => setMentors((d.users ?? []).filter((u: { role: string }) => u.role === 'MENTOR')));
    fetch('/api/companies').then((r) => r.json()).then((d) => setCompanies(d.companies ?? []));
  }, [isAdmin]);

  const reset = () => { setForm({ ...blank }); setEditingId(null); setOwnerType('ADMIN'); setOwnerUserId(''); setOwnerCompanyId(''); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        description: form.description,
        technologies: form.technologies.split(',').map((s) => s.trim()).filter(Boolean),
        repoUrl: form.repoUrl,
        demoUrl: form.demoUrl,
        status: form.status,
        isPublic: form.isPublic,
        goals: form.goals,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
      };
      // Admin sets/changes ownership (create or transfer-on-edit), preserving
      // the "exactly one owner" invariant.
      if (isAdmin) {
        payload.ownerType = ownerType;
        if (ownerType === 'COMPANY') payload.ownerCompanyId = ownerCompanyId;
        else if (ownerType === 'MENTOR') payload.ownerUserId = ownerUserId;
        else payload.ownerUserId = ownerUserId || meId; // ADMIN → self by default
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
    setEditingId(p.id);
    setForm({
      name: p.name, description: p.description ?? '', technologies: p.technologies.join(', '),
      repoUrl: p.repoUrl ?? '', demoUrl: p.demoUrl ?? '', status: p.status, isPublic: p.isPublic,
      goals: p.goals ?? '', startDate: p.startDate ? p.startDate.slice(0, 10) : '', endDate: p.endDate ? p.endDate.slice(0, 10) : '',
    });
    setOwnerType(p.ownerType);
    setOwnerUserId(p.ownerUser?.id ?? '');
    setOwnerCompanyId(p.ownerCompany?.id ?? '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const remove = async (id: string) => {
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
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
  const deleteTask = async (taskId: string) => {
    await fetch(`/api/project-tasks/${taskId}`, { method: 'DELETE' });
    await load();
  };

  const ownerLabel = (p: Project) =>
    p.ownerType === 'COMPANY' ? p.ownerCompany?.name : p.ownerUser?.fullName;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.projects.title}</h1>
        <p className="text-gray-500 mt-1">{t.projects.subtitle}</p>
      </div>

      <Card className="mb-6 max-w-3xl">
        <CardHeader><CardTitle>{editingId ? t.projects.editProject : t.projects.newProject}</CardTitle></CardHeader>
        {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
        <form onSubmit={submit} className="space-y-3">
          <Input label={t.projects.name} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.projects.description}</label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3} className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm" />
          </div>
          <Input label={t.projects.technologies} hint={t.projects.techHint} value={form.technologies} onChange={(e) => setForm({ ...form, technologies: e.target.value })} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label={t.projects.repoUrl} type="url" placeholder="https://github.com/..." value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} />
            <Input label={t.projects.demoUrl} type="url" placeholder="https://..." value={form.demoUrl} onChange={(e) => setForm({ ...form, demoUrl: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select label={t.projects.status} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
              options={[
                { value: 'DRAFT', label: t.projects.draft },
                { value: 'ACTIVE', label: t.projects.active },
                { value: 'COMPLETED', label: t.projects.completed },
                { value: 'ARCHIVED', label: t.projects.archived },
                { value: 'CANCELLED', label: t.projects.cancelled },
              ]} />
            <label className="flex items-center gap-2 text-sm text-gray-700 mt-7">
              <input type="checkbox" checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} />
              {t.projects.isPublic}
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label={t.projects.startDate} type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            <Input label={t.projects.endDate} type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.projects.goals}</label>
            <textarea value={form.goals} onChange={(e) => setForm({ ...form, goals: e.target.value })}
              rows={2} className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm" />
          </div>

          {isAdmin && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-gray-100 pt-3">
              {editingId && <p className="sm:col-span-2 text-xs text-gray-500">{t.projects.transferHint}</p>}
              <Select label={t.projects.owner} value={ownerType} onChange={(e) => setOwnerType(e.target.value)}
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
            {editingId && <Button type="button" variant="outline" onClick={reset}>{t.common.cancel}</Button>}
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t.projects.allProjects} ({projects.length})</CardTitle></CardHeader>
        {loading ? (
          <p className="text-center py-10 text-gray-400">{t.common.loading}</p>
        ) : projects.length === 0 ? (
          <p className="text-center py-10 text-gray-400">{t.projects.none}</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {projects.map((p) => (
              <div key={p.id} className="py-3">
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
                    {p.description && <p className="text-sm text-gray-600 mt-1 line-clamp-2">{p.description}</p>}
                    <div className="flex flex-wrap gap-1 mt-2">
                      {p.technologies.map((tech) => (
                        <span key={tech} className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs">{tech}</span>
                      ))}
                    </div>
                    <div className="flex gap-3 mt-2 text-xs">
                      {p.repoUrl && <a href={p.repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-600 hover:text-blue-600"><Github className="h-3.5 w-3.5" />{t.projects.repo}</a>}
                      {p.demoUrl && <a href={p.demoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gray-600 hover:text-blue-600"><ExternalLink className="h-3.5 w-3.5" />{t.projects.demo}</a>}
                      {(p.startDate || p.endDate) && (
                        <span className="text-gray-400">
                          {p.startDate ? new Date(p.startDate).toLocaleDateString() : '…'} – {p.endDate ? new Date(p.endDate).toLocaleDateString() : '…'}
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
                                    <button onClick={() => deleteTask(tk.id)} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
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
                    <button onClick={() => edit(p)} aria-label={t.projects.editProject} className="p-2 text-gray-400 hover:text-blue-600"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => remove(p.id)} aria-label={t.projects.deleteProject} className="p-2 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
