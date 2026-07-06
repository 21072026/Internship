'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Pencil, Trash2 } from 'lucide-react';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT } from '@/i18n/client';

interface Cohort {
  id: string;
  name: string;
  term: string | null;
  interns: number;
  distribution: Record<string, number>;
}

const HIRED = ['HIRED_660', 'EMPLOYED_700'];

export default function AdminCohortsPage() {
  const t = useT();
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [name, setName] = useState('');
  const [term, setTerm] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch('/api/cohorts');
    if (res.ok) setCohorts((await res.json()).cohorts ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/cohorts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, term }),
      });
      if (res.ok) { setName(''); setTerm(''); await load(); }
    } finally {
      setSaving(false);
    }
  };

  const rename = async (c: Cohort) => {
    const next = window.prompt(t.cohorts.name, c.name);
    if (next === null || !next.trim() || next === c.name) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/cohorts/${c.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next.trim() }),
      });
      if (res.ok) await load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Cohort) => {
    if (!window.confirm(t.cohorts.confirmDelete.replace('{name}', c.name))) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/cohorts/${c.id}`, { method: 'DELETE' });
      if (res.ok) await load();
    } finally {
      setSaving(false);
    }
  };

  const hiredOf = (d: Record<string, number>) => HIRED.reduce((n, s) => n + (d[s] || 0), 0);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.cohorts.title}</h1>
        <p className="text-gray-500 mt-1">{t.cohorts.subtitle}</p>
      </div>

      <Card className="mb-6 max-w-xl">
        <CardHeader><CardTitle>{t.cohorts.newCohort}</CardTitle></CardHeader>
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[160px]"><Input label={t.cohorts.name} value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <div className="flex-1 min-w-[140px]"><Input label={t.cohorts.term} placeholder="2026 Spring" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
          <Button type="submit" loading={saving}>{t.cohorts.create}</Button>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t.cohorts.comparison} ({cohorts.length})</CardTitle></CardHeader>
        {loading ? (
          <SkeletonRows rows={5} />
        ) : cohorts.length === 0 ? (
          <p className="text-center py-10 text-gray-400">{t.cohorts.none}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="py-2 pr-4">{t.cohorts.name}</th>
                  <th className="py-2 pr-4">{t.cohorts.term}</th>
                  <th className="py-2 pr-4">{t.cohorts.interns}</th>
                  <th className="py-2 pr-4">{t.cohorts.hired}</th>
                  <th className="py-2 pr-4">{t.cohorts.hireRate}</th>
                  <th className="py-2 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {cohorts.map((c) => {
                  const hired = hiredOf(c.distribution);
                  const rate = c.interns ? Math.round((hired / c.interns) * 100) : 0;
                  return (
                    <tr key={c.id} data-testid={`cohort-row-${c.id}`} className="border-b border-gray-50">
                      <td className="py-2 pr-4 font-medium text-gray-900">{c.name}</td>
                      <td className="py-2 pr-4 text-gray-500">{c.term || '—'}</td>
                      <td className="py-2 pr-4">{c.interns}</td>
                      <td className="py-2 pr-4">{hired}</td>
                      <td className="py-2 pr-4">{rate}%</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <button onClick={() => rename(c)} disabled={saving} aria-label={t.common.edit} className="text-gray-400 hover:text-blue-600 mr-3"><Pencil className="h-4 w-4 inline" /></button>
                        <button onClick={() => remove(c)} disabled={saving} aria-label={t.common.delete} className="text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4 inline" /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
