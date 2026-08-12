'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';
import Link from 'next/link';

type Company = { id: string; name: string };
type Owner = { id: string; fullName: string; companyId: string | null };
type Requisition = {
  id: string; companyId: string; title: string; description: string | null; status: string;
  openings: number; filled: number; requiredSkills: unknown; city: string | null;
  workMode: string | null; startDate: string | null; ownerId: string | null;
  company: Company; owner: { id: string; fullName: string } | null;
};

const STATUSES = ['DRAFT', 'OPEN', 'ON_HOLD', 'FILLED', 'CANCELLED'] as const;
const badgeVariant: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  DRAFT: 'default', OPEN: 'success', ON_HOLD: 'warning', FILLED: 'info', CANCELLED: 'danger',
};

const emptyForm = { companyId: '', title: '', description: '', status: 'DRAFT', openings: '1', filled: '0', requiredSkills: '', city: '', workMode: '', startDate: '', ownerId: '' };

export function RequisitionsManager({ admin }: { admin: boolean }) {
  const t = useT();
  const r = t.requisitions;
  const [items, setItems] = useState<Requisition[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Requisition | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const statusLabel = (status: string) => r.statuses[status as keyof typeof r.statuses] ?? status;
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const qs = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (search.trim()) qs.set('search', search.trim());
    if (companyFilter) qs.set('companyId', companyFilter);
    if (statusFilter) qs.set('status', statusFilter);
    try {
      const res = await fetch(`/api/requisitions?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || r.errors.loadFailed);
      setItems(data.requisitions ?? []);
      setCompanies(data.companies ?? []);
      setOwners(data.owners ?? []);
      setTotalPages(data.totalPages ?? 1);
    } catch (e) { setError(e instanceof Error ? e.message : r.errors.loadFailed); }
    finally { setLoading(false); }
  }, [page, search, companyFilter, statusFilter, r.errors.loadFailed]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPage(1); }, [search, companyFilter, statusFilter]);

  const availableOwners = useMemo(() => owners.filter((o) => !form.companyId || o.companyId === form.companyId), [owners, form.companyId]);
  const openCreate = () => { setEditing(null); setForm({ ...emptyForm, companyId: admin ? '' : companies[0]?.id ?? '' }); setShowForm(true); };
  const openEdit = (item: Requisition) => {
    setEditing(item);
    setForm({
      companyId: item.companyId, title: item.title, description: item.description ?? '', status: item.status,
      openings: String(item.openings), filled: String(item.filled),
      requiredSkills: Array.isArray(item.requiredSkills) ? item.requiredSkills.join(', ') : '',
      city: item.city ?? '', workMode: item.workMode ?? '', startDate: item.startDate?.slice(0, 10) ?? '', ownerId: item.ownerId ?? '',
    });
    setShowForm(true);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError('');
    const payload = {
      ...form, openings: Number(form.openings), filled: Number(form.filled),
      requiredSkills: form.requiredSkills.split(',').map((s) => s.trim()).filter(Boolean),
      description: form.description || null, city: form.city || null, workMode: form.workMode || null,
      startDate: form.startDate ? new Date(`${form.startDate}T00:00:00.000Z`).toISOString() : null,
      ownerId: form.ownerId || null,
    };
    if (editing) delete (payload as Partial<typeof payload>).companyId;
    try {
      const res = await fetch(editing ? `/api/requisitions/${editing.id}` : '/api/requisitions', {
        method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || r.errors.saveFailed);
      setShowForm(false); setEditing(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : r.errors.saveFailed); }
    finally { setSaving(false); }
  };
  const cancelItem = async (item: Requisition) => {
    const res = await fetch(`/api/requisitions/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'CANCELLED' }) });
    if (res.ok) await load(); else setError(r.errors.saveFailed);
  };

  return <div data-testid={admin ? 'admin-requisitions' : 'company-requisitions'}>
    <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
      <div><h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{r.title}</h1><p className="text-gray-500 dark:text-gray-400 mt-1">{r.subtitle}</p></div>
      <Button onClick={openCreate}><Plus className="h-4 w-4" />{r.create}</Button>
    </div>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
      <Input aria-label={r.filters.searchPlaceholder} placeholder={r.filters.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} />
      {admin && <Select aria-label={r.company} value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} options={[{ value: '', label: r.filters.allCompanies }, ...companies.map((c) => ({ value: c.id, label: c.name }))]} />}
      <Select aria-label={r.status} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} options={[{ value: '', label: r.filters.allStatuses }, ...STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))]} />
    </div>
    {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</div>}
    {loading ? <p className="py-10 text-center text-gray-500">{t.common.loading}</p> : items.length === 0 ? <Card className="py-12 text-center"><p className="font-medium text-gray-700 dark:text-gray-200">{r.empty.title}</p><p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{r.empty.description}</p></Card> :
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">{items.map((item) => <Card key={item.id}>
        <CardHeader><div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><CardTitle className="break-words">{item.title}</CardTitle><p className="text-sm text-gray-500 dark:text-gray-400">{item.company.name}</p></div><Badge variant={badgeVariant[item.status] ?? 'default'}>{statusLabel(item.status)}</Badge></div></CardHeader>
        <div className="space-y-3 text-sm"><div className="flex flex-wrap gap-x-6 gap-y-1 text-gray-600 dark:text-gray-300"><span>{r.filled}: <strong>{item.filled}/{item.openings}</strong></span>{item.owner && <span>{r.owner}: {item.owner.fullName}</span>}{item.city && <span>{r.city}: {item.city}</span>}</div>
        {Array.isArray(item.requiredSkills) && item.requiredSkills.length > 0 && <div className="flex flex-wrap gap-1">{item.requiredSkills.map((skill) => <Badge key={String(skill)}>{String(skill)}</Badge>)}</div>}
        <div className="flex flex-wrap gap-2">{!admin && <Link className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200" href={`/company/requisitions/${item.id}`}>{r.details}</Link>}<Button size="sm" variant="outline" onClick={() => openEdit(item)}><Pencil className="h-4 w-4" />{r.edit}</Button>{!['CANCELLED', 'FILLED'].includes(item.status) && <Button size="sm" variant="ghost" onClick={() => void cancelItem(item)}><XCircle className="h-4 w-4" />{r.close}</Button>}</div></div>
      </Card>)}</div>}
    <div className="mt-5 flex items-center justify-center gap-3"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{r.pagination.previous}</Button><span className="text-sm text-gray-500">{r.pagination.page.replace('{page}', String(page)).replace('{total}', String(totalPages))}</span><Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>{r.pagination.next}</Button></div>
    {showForm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><form onSubmit={save} className="max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-2xl bg-white p-6 dark:bg-gray-900">
      <div className="flex items-center justify-between"><h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">{editing ? r.edit : r.create}</h2><button type="button" aria-label={r.cancel} onClick={() => setShowForm(false)}><XCircle className="h-5 w-5" /></button></div>
      {admin && !editing && <Select required label={r.company} value={form.companyId} onChange={(e) => setForm({ ...form, companyId: e.target.value, ownerId: '' })} options={companies.map((c) => ({ value: c.id, label: c.name }))} placeholder={r.validation.companyRequired} />}
      <Input required label={r.requisitionTitle} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      <div><label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{r.description}</label><Textarea maxLength={2000} showCounter value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3"><Select label={r.status} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} options={STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))} /><Input required type="number" min={1} label={r.openings} value={form.openings} onChange={(e) => setForm({ ...form, openings: e.target.value })} /><Input required type="number" min={0} label={r.filled} value={form.filled} onChange={(e) => setForm({ ...form, filled: e.target.value })} /></div>
      <Input label={r.requiredSkills} hint={r.skillsHint} value={form.requiredSkills} onChange={(e) => setForm({ ...form, requiredSkills: e.target.value })} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3"><Input label={r.city} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /><Input label={r.workMode} value={form.workMode} onChange={(e) => setForm({ ...form, workMode: e.target.value })} /><Input type="date" label={r.startDate} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></div>
      <Select label={r.owner} value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })} options={[{ value: '', label: r.noOwner }, ...availableOwners.map((o) => ({ value: o.id, label: o.fullName }))]} />
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setShowForm(false)}>{r.cancel}</Button><Button type="submit" loading={saving}>{r.save}</Button></div>
    </form></div>}
  </div>;
}
