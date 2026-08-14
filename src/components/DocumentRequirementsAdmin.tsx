'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';

interface Organization { id: string; name: string }
interface Stage { key: string; label: string }
interface Requirement {
  id: string; key: string; labels: { en: string; tr: string; de: string };
  appliesToStage: string | null; appliesToRole: string | null;
  mandatory: boolean; order: number; active: boolean;
}
interface MissingRow {
  user: { id: string; fullName: string; email: string };
  stages: string[];
  missing: { id: string; label: string }[];
}

const emptyForm = { key: '', en: '', tr: '', de: '', stage: '', role: 'MENTEE', mandatory: true, order: '0', active: true };

export function DocumentRequirementsAdmin() {
  const t = useT();
  const d = t.documentRequirements;
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [orgId, setOrgId] = useState('');
  const [stages, setStages] = useState<Stage[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [missing, setMissing] = useState<MissingRow[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('MENTEE');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [eligibleUserCount, setEligibleUserCount] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/admin/organizations').then((r) => r.json()).then((body) => {
      const values = body.organizations ?? [];
      setOrgs(values);
      if (values[0]) setOrgId(values[0].id);
    }).catch(() => setError(d.loadFailed));
  }, [d.loadFailed]);

  const load = useCallback(async () => {
    if (!orgId) return;
    setError('');
    try {
      const [requirementsRes, missingRes, stagesRes] = await Promise.all([
        fetch(`/api/admin/document-requirements?orgId=${encodeURIComponent(orgId)}`),
        fetch(`/api/admin/documents/missing?orgId=${encodeURIComponent(orgId)}&role=${encodeURIComponent(roleFilter)}&stage=${encodeURIComponent(stageFilter)}&search=${encodeURIComponent(search)}&page=${page}&pageSize=50`),
        fetch(`/api/admin/organizations/${orgId}/pipeline-stages`),
      ]);
      if (!requirementsRes.ok || !missingRes.ok || !stagesRes.ok) throw new Error();
      setRequirements((await requirementsRes.json()).requirements ?? []);
      const missingBody = await missingRes.json();
      setMissing(missingBody.rows ?? []);
      setEligibleUserCount(missingBody.eligibleUserCount ?? 0);
      setHasNextPage(Boolean(missingBody.hasNextPage));
      setStages((await stagesRes.json()).stages ?? []);
    } catch {
      setError(d.loadFailed);
    }
  }, [orgId, stageFilter, roleFilter, search, page, d.loadFailed]);
  useEffect(() => { load(); }, [load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError('');
    const body = {
      orgId, key: form.key, labels: { en: form.en, tr: form.tr, de: form.de },
      appliesToStage: form.stage || null, appliesToRole: form.role || null,
      mandatory: form.mandatory, order: Number(form.order), active: form.active,
    };
    const res = await fetch(editingId ? `/api/admin/document-requirements/${editingId}` : '/api/admin/document-requirements', {
      method: editingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.ok) { setForm(emptyForm); setEditingId(''); await load(); }
    else setError((await res.json().catch(() => ({}))).error || d.saveFailed);
    setSaving(false);
  };

  const edit = (requirement: Requirement) => {
    setEditingId(requirement.id);
    setForm({ key: requirement.key, en: requirement.labels.en, tr: requirement.labels.tr, de: requirement.labels.de, stage: requirement.appliesToStage || '', role: requirement.appliesToRole || '', mandatory: requirement.mandatory, order: String(requirement.order), active: requirement.active });
  };

  const toggle = async (requirement: Requirement) => {
    await fetch(`/api/admin/document-requirements/${requirement.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId, active: !requirement.active }),
    });
    await load();
  };

  const stageName = (key: string) => stages.find((stage) => stage.key === key)?.label || key;

  return <div className="mt-8 space-y-6" data-testid="document-requirements-admin">
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{d.organization}
        <select value={orgId} onChange={(e) => { setPage(1); setOrgId(e.target.value); }} className="mt-1 block rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm">
          {orgs.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
        </select>
      </label>
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}

    <Card>
      <CardHeader><CardTitle>{d.configurationTitle}</CardTitle></CardHeader>
      <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        <Input label={d.key} required value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
        <Input label={d.labelEn} required value={form.en} onChange={(e) => setForm({ ...form, en: e.target.value })} />
        <Input label={d.labelTr} required value={form.tr} onChange={(e) => setForm({ ...form, tr: e.target.value })} />
        <Input label={d.labelDe} required value={form.de} onChange={(e) => setForm({ ...form, de: e.target.value })} />
        <label className="text-sm text-gray-700 dark:text-gray-300">{d.stage}<select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })} className="mt-1 block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2"><option value="">{d.allStages}</option>{stages.map((stage) => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></label>
        <label className="text-sm text-gray-700 dark:text-gray-300">{d.role}<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="mt-1 block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2"><option value="">{d.allRoles}</option>{['MENTEE', 'MENTOR', 'COMPANY', 'SOURCE', 'ADMIN'].map((role) => <option key={role}>{role}</option>)}</select></label>
        <Input label={d.order} type="number" min={0} value={form.order} onChange={(e) => setForm({ ...form, order: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.mandatory} onChange={(e) => setForm({ ...form, mandatory: e.target.checked })} />{d.mandatory}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />{d.active}</label>
        <div className="md:col-span-3 flex gap-2"><Button type="submit" loading={saving}>{editingId ? d.save : d.add}</Button>{editingId && <Button type="button" variant="outline" onClick={() => { setEditingId(''); setForm(emptyForm); }}>{t.common.cancel}</Button>}</div>
      </form>
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {requirements.length === 0 && <p className="py-4 text-sm text-gray-500">{d.noneConfigured}</p>}
        {requirements.map((requirement) => <div key={requirement.id} className="flex flex-wrap items-center gap-3 py-3">
          <span className="font-medium text-gray-900 dark:text-gray-100">{requirement.labels.en}</span><code className="text-xs text-gray-500">{requirement.key}</code>
          {requirement.appliesToStage && <Badge variant="info">{stageName(requirement.appliesToStage)}</Badge>}
          {requirement.mandatory && <Badge variant="warning">{d.mandatory}</Badge>}
          <span className="text-xs text-gray-500">#{requirement.order}</span>
          <div className="ml-auto flex gap-2"><Button size="sm" variant="outline" onClick={() => edit(requirement)}>{d.edit}</Button><Button size="sm" variant="outline" onClick={() => toggle(requirement)}>{requirement.active ? d.disable : d.enable}</Button></div>
        </div>)}
      </div>
    </Card>

    <Card data-testid="admin-missing-documents">
      <CardHeader><CardTitle>{d.missingTitle}</CardTitle></CardHeader>
      <div className="mb-4 flex flex-wrap gap-3">
        <select aria-label={d.stageFilter} value={stageFilter} onChange={(e) => { setPage(1); setStageFilter(e.target.value); }} className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"><option value="">{d.allStages}</option>{stages.map((stage) => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select>
        <select aria-label={d.role} value={roleFilter} onChange={(e) => { setPage(1); setRoleFilter(e.target.value); }} className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm">{['MENTEE', 'MENTOR', 'COMPANY', 'SOURCE', 'ADMIN'].map((role) => <option key={role}>{role}</option>)}</select>
        <Input aria-label={d.search} placeholder={d.search} value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} className="max-w-xs" />
      </div>
      {missing.length === 0 ? <p className="text-sm text-gray-500">{d.noneMissing}</p> : <div className="divide-y divide-gray-100 dark:divide-gray-800">{missing.map((row) => <div key={row.user.id} className="py-3">
        <Link href={`/admin/candidates/${row.user.id}`} className="font-medium text-blue-600 hover:underline">{row.user.fullName}</Link>
        <p className="text-xs text-gray-500">{row.stages.map(stageName).join(', ') || d.noStage}</p>
        <div className="mt-2 flex flex-wrap gap-2">{row.missing.map((requirement) => <Badge key={requirement.id} variant="warning">{requirement.label}</Badge>)}</div>
      </div>)}</div>}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-4 dark:border-gray-800" data-testid="missing-documents-pagination">
        <p className="text-sm text-gray-500 dark:text-gray-400">{d.eligibleUsers.replace('{count}', String(eligibleUserCount))} · {d.page.replace('{page}', String(page))}</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>{t.common.prev}</Button>
          <Button type="button" variant="outline" size="sm" disabled={!hasNextPage} onClick={() => setPage((current) => current + 1)}>{t.common.next}</Button>
        </div>
      </div>
    </Card>
  </div>;
}
