'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';

interface Mentee {
  id: string;
  fullName: string;
  email: string;
  university: string | null;
  department: string | null;
  skills: string[];
  assigned: boolean;
  mentor: string | null;
}

export default function SourcePortal() {
  const t = useT();
  const [mentees, setMentees] = useState<Mentee[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ fullName: '', email: '', university: '', department: '', skills: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/source/mentees');
    if (res.ok) setMentees((await res.json()).mentees ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.fullName.trim() || !form.email.trim()) return;
    setSaving(true); setError(''); setOk('');
    try {
      const res = await fetch('/api/source/mentees', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t.common.error);
      setForm({ fullName: '', email: '', university: '', department: '', skills: '' });
      setOk(t.sourcePortal.added);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.sourcePortal.title}</h1>
        <p className="text-gray-500 mt-1">{t.sourcePortal.subtitle}</p>
      </div>

      <Card className="mb-6 max-w-2xl">
        <CardHeader><CardTitle>{t.sourcePortal.addMentee}</CardTitle></CardHeader>
        {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
        {ok && <div className="mb-3 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">✓ {ok}</div>}
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label={t.sourcePortal.fullName} required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            <Input label={t.sourcePortal.email} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Input label={t.sourcePortal.university} value={form.university} onChange={(e) => setForm({ ...form, university: e.target.value })} />
            <Input label={t.sourcePortal.department} value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
          </div>
          <Input label={t.sourcePortal.skills} hint={t.sourcePortal.skillsHint} value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} />
          <Button type="submit" loading={saving}>{t.sourcePortal.submit}</Button>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t.sourcePortal.myMentees} ({mentees.length})</CardTitle></CardHeader>
        {loading ? (
          <p className="text-center py-10 text-gray-400">{t.common.loading}</p>
        ) : mentees.length === 0 ? (
          <p className="text-center py-10 text-gray-400">{t.sourcePortal.none}</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {mentees.map((m) => (
              <div key={m.id} data-testid={`src-mentee-${m.id}`} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{m.fullName}</p>
                  <p className="text-xs text-gray-500 truncate">{m.email}{m.university ? ` · ${m.university}` : ''}</p>
                </div>
                {m.assigned ? (
                  <Badge variant="success">{t.sourcePortal.assignedTo} {m.mentor}</Badge>
                ) : (
                  <Badge variant="warning">{t.sourcePortal.pending}</Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
