'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';

// The one project create/edit form (#2270).
//
// It used to live inside ProjectsManager, whose only two mount points are
// /admin/projects and /mentor/projects — so a mentee, who can own a project
// since #1222 and create one since #2270, had no form anywhere. Extracted
// verbatim (same fields, same order, same testids) so the admin/mentor screens
// are unchanged and the portal reuses it instead of growing a second one.
//
// Which controls appear is the caller's decision, because the answer differs
// per role rather than per project:
//   showOwnerPicker  — admin only (create-with-owner / transfer-on-edit)
//   showTermsPicker  — needs /api/contributor-terms/keys (ADMIN/MENTOR), and
//                      its "don't ask" option switches the project-level IP
//                      gate off, which is not a contributor's call
//   showVisibility   — the isPublic checkbox publishes to the anonymous
//                      showcase and to sitemap.xml
//   canEditProtected — false for a non-owner member: the owner-only field set
//                      (#619) is disabled and simply not sent

export type ProjectFormStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED' | 'CANCELLED';

/** A project as this form reads it — the shape both callers already hold. */
export interface ProjectFormInitial {
  id: string;
  name: string;
  description?: string | null;
  technologies?: string[];
  repoUrl?: string | null;
  demoUrl?: string | null;
  boardUrl?: string | null;
  status?: string;
  isPublic?: boolean;
  goals?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  contributorTermsKey?: string | null;
  contributorTermsRequired?: boolean;
  ownerType?: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY';
  ownerUser?: { id: string; fullName: string } | null;
  ownerCompany?: { id: string; name: string } | null;
}

// Sentinel for "this project has no IP question" — distinct from '' (platform
// default), which is what an unset contributorTermsKey means.
export const TERMS_NONE = '__none__';

const blank = {
  name: '', description: '', technologies: '', repoUrl: '', demoUrl: '', boardUrl: '',
  status: 'ACTIVE', isPublic: false, goals: '', startDate: '', endDate: '', contributorTerms: '',
};

function valuesFrom(p?: ProjectFormInitial | null) {
  if (!p) return { ...blank };
  return {
    name: p.name,
    description: p.description ?? '',
    technologies: (p.technologies ?? []).join(', '),
    repoUrl: p.repoUrl ?? '',
    demoUrl: p.demoUrl ?? '',
    boardUrl: p.boardUrl ?? '',
    status: p.status ?? 'ACTIVE',
    isPublic: p.isPublic ?? false,
    goals: p.goals ?? '',
    startDate: p.startDate ? p.startDate.slice(0, 10) : '',
    endDate: p.endDate ? p.endDate.slice(0, 10) : '',
    contributorTerms: p.contributorTermsRequired === false ? TERMS_NONE : (p.contributorTermsKey ?? ''),
  };
}

export function ProjectForm({
  project,
  canEditProtected,
  showOwnerPicker = false,
  showTermsPicker = false,
  showVisibility = true,
  meId = '',
  onSaved,
  onCancel,
}: {
  /** The project being edited; omit (or null) to create one. */
  project?: ProjectFormInitial | null;
  canEditProtected: boolean;
  showOwnerPicker?: boolean;
  showTermsPicker?: boolean;
  showVisibility?: boolean;
  /** The acting user's id — ADMIN ownership is always the acting admin. */
  meId?: string;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const editingId = project?.id ?? null;
  const [form, setForm] = useState(() => valuesFrom(project));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [termsKeys, setTermsKeys] = useState<{ key: string; version: string }[]>([]);
  const [mentors, setMentors] = useState<{ id: string; fullName: string }[]>([]);
  const [mentees, setMentees] = useState<{ id: string; fullName: string }[]>([]);
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [ownerType, setOwnerType] = useState(project?.ownerType ?? 'ADMIN');
  const [ownerUserId, setOwnerUserId] = useState(project?.ownerUser?.id ?? '');
  const [ownerCompanyId, setOwnerCompanyId] = useState(project?.ownerCompany?.id ?? '');

  // The terms documents this installation has (#1026). Empty list is fine — the
  // picker then offers only the platform default and "don't ask".
  useEffect(() => {
    if (!showTermsPicker) return;
    fetch('/api/contributor-terms/keys')
      .then((r) => (r.ok ? r.json() : { keys: [] }))
      .then((d) => setTermsKeys(d.keys ?? []))
      .catch(() => {});
  }, [showTermsPicker]);

  useEffect(() => {
    if (!showOwnerPicker) return;
    fetch('/api/users?view=picker')
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => {
        const users = (d.users ?? []) as { id: string; fullName: string; role: string }[];
        setMentors(users.filter((u) => u.role === 'MENTOR' || u.role === 'ADMIN'));
        setMentees(users.filter((u) => u.role === 'MENTEE'));
      })
      .catch(() => {});
    fetch('/api/companies')
      .then((r) => (r.ok ? r.json() : { companies: [] }))
      .then((d) => setCompanies(d.companies ?? []))
      .catch(() => {});
  }, [showOwnerPicker]);

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
      if (canEditProtected) {
        Object.assign(payload, {
          name: form.name,
          status: form.status,
          startDate: form.startDate || null,
          endDate: form.endDate || null,
        });
        // Not offered → not sent, so the server keeps its own default (private
        // on create, unchanged on edit) rather than being handed a stale false.
        if (showVisibility) payload.isPublic = form.isPublic;
        if (showTermsPicker) {
          // One control, three meanings (#1026): '' = platform default,
          // TERMS_NONE = don't ask at all, anything else = that document.
          payload.contributorTermsRequired = form.contributorTerms !== TERMS_NONE;
          payload.contributorTermsKey = form.contributorTerms === TERMS_NONE ? '' : form.contributorTerms;
        }
      }
      // Admin sets/changes ownership (create or transfer-on-edit), preserving
      // the "exactly one owner" invariant.
      if (showOwnerPicker) {
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed');
      await onSaved();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const locked = !canEditProtected && !!editingId;

  return (
    <Card className="mb-6 max-w-3xl" data-testid="project-form">
      <CardHeader><CardTitle>{editingId ? t.projects.editProject : t.projects.newProject}</CardTitle></CardHeader>
      {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
      <form onSubmit={submit} className="space-y-3">
        <Input label={t.projects.name} required disabled={locked} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        {locked && <p className="text-xs text-gray-400 -mt-2">{t.projects.ownerOnlyHint}</p>}
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
          <Select label={t.projects.status} disabled={locked} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
            options={[
              { value: 'DRAFT', label: t.projects.draft },
              { value: 'ACTIVE', label: t.projects.active },
              { value: 'COMPLETED', label: t.projects.completed },
              { value: 'ARCHIVED', label: t.projects.archived },
              { value: 'CANCELLED', label: t.projects.cancelled },
            ]} />
          {showVisibility && (
            <label className="flex items-center gap-2 text-sm text-gray-700 mt-7">
              <input type="checkbox" disabled={locked} checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} />
              {t.projects.isPublic}
            </label>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label={t.projects.startDate} type="date" disabled={locked} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          <Input label={t.projects.endDate} type="date" disabled={locked} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
        </div>
        {showTermsPicker && (
          <div>
            <Select
              label={t.contributorTerms.projectTermsTitle}
              data-testid="project-terms-select"
              disabled={locked}
              value={form.contributorTerms}
              onChange={(e) => setForm({ ...form, contributorTerms: e.target.value })}
              options={[
                { value: '', label: t.contributorTerms.projectTermsDefault },
                ...termsKeys
                  .filter((k) => k.key !== 'default')
                  .map((k) => ({ value: k.key, label: `${k.key} (v${k.version})` })),
                { value: TERMS_NONE, label: t.contributorTerms.projectTermsNone },
              ]} />
            <p className="mt-1 text-xs text-gray-500">{t.contributorTerms.projectTermsHint}</p>
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.projects.goals}</label>
          <Textarea value={form.goals} onChange={(e) => setForm({ ...form, goals: e.target.value })}
            rows={2} maxLength={5000} showCounter />
        </div>

        {showOwnerPicker && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-gray-100 pt-3">
            {editingId && <p className="sm:col-span-2 text-xs text-gray-500">{t.projects.transferHint}</p>}
            <Select label={t.projects.owner} value={ownerType} onChange={(e) => { setOwnerType(e.target.value as typeof ownerType); setOwnerUserId(''); setOwnerCompanyId(''); }}
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
          <Button type="button" variant="outline" onClick={onCancel}>{t.common.cancel}</Button>
        </div>
      </form>
    </Card>
  );
}
