'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT } from '@/i18n/client';

interface Source {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  mentees: number;
  hired: number;
  conversion: number;
}

export default function AdminSourcesPage() {
  const t = useT();
  const [sources, setSources] = useState<Source[]>([]);
  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/sources');
    if (res.ok) setSources((await res.json()).sources ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const [loginSourceId, setLoginSourceId] = useState('');
  const [loginName, setLoginName] = useState('');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginMsg, setLoginMsg] = useState<string | null>(null);

  const createLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginSourceId || !loginEmail.trim()) return;
    setSaving(true); setLoginMsg(null);
    try {
      const res = await fetch('/api/admin/source-users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: loginSourceId, email: loginEmail, fullName: loginName || loginEmail }),
      });
      const data = await res.json();
      setLoginMsg(res.ok ? t.sources.loginCreated : data.error || t.common.error);
      if (res.ok) { setLoginEmail(''); setLoginName(''); }
    } finally {
      setSaving(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/sources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, contactName, contactEmail }),
      });
      if (res.ok) { setName(''); setContactName(''); setContactEmail(''); await load(); }
      else setError((await res.json().catch(() => ({}))).error ?? t.common.error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/sources/${id}`, { method: 'DELETE' });
      if (res.ok) await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.sources.title}</h1>
        <p className="text-gray-500 mt-1">{t.sources.subtitle}</p>
      </div>

      <Card className="mb-6 max-w-2xl">
        <CardHeader><CardTitle>{t.sources.newSource}</CardTitle></CardHeader>
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[160px]"><Input label={t.sources.name} value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <div className="flex-1 min-w-[140px]"><Input label={t.sources.contactName} value={contactName} onChange={(e) => setContactName(e.target.value)} /></div>
          <div className="flex-1 min-w-[160px]"><Input label={t.sources.contactEmail} type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} /></div>
          <Button type="submit" loading={saving}>{t.sources.create}</Button>
        </form>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      </Card>

      <Card className="mb-6 max-w-2xl">
        <CardHeader><CardTitle>{t.sources.addLogin}</CardTitle></CardHeader>
        <p className="text-sm text-gray-500 mb-3">{t.sources.addLoginHint}</p>
        <form onSubmit={createLogin} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.sources.name}</label>
            <select value={loginSourceId} onChange={(e) => setLoginSourceId(e.target.value)} required className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm">
              <option value="">—</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-[140px]"><Input id="source-login-name" label={t.sources.contactName} value={loginName} onChange={(e) => setLoginName(e.target.value)} /></div>
          <div className="flex-1 min-w-[160px]"><Input id="source-login-email" label={t.sources.contactEmail} type="email" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} required /></div>
          <Button type="submit" loading={saving}>{t.sources.createLogin}</Button>
        </form>
        {loginMsg && <p className="text-sm text-gray-600 mt-2">{loginMsg}</p>}
      </Card>

      <Card>
        <CardHeader><CardTitle>{t.sources.title} ({sources.length})</CardTitle></CardHeader>
        {loading ? (
          <SkeletonRows rows={5} />
        ) : sources.length === 0 ? (
          <p className="text-center py-10 text-gray-400">{t.sources.none}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="py-2 pr-4">{t.sources.name}</th>
                  <th className="py-2 pr-4">{t.sources.contact}</th>
                  <th className="py-2 pr-4">{t.sources.mentees}</th>
                  <th className="py-2 pr-4">{t.sources.hired}</th>
                  <th className="py-2 pr-4">{t.sources.conversion}</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id} data-testid={`source-row-${s.id}`} className="border-b border-gray-50">
                    <td className="py-2 pr-4 font-medium text-gray-900">{s.name}</td>
                    <td className="py-2 pr-4 text-gray-500">
                      {s.contactName || s.contactEmail ? (
                        <span>{s.contactName}{s.contactName && s.contactEmail ? ' · ' : ''}{s.contactEmail}</span>
                      ) : '—'}
                    </td>
                    <td className="py-2 pr-4">{s.mentees}</td>
                    <td className="py-2 pr-4">{s.hired}</td>
                    <td className="py-2 pr-4">{s.conversion}%</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => remove(s.id)}
                        disabled={saving}
                        aria-label={t.common.delete}
                        className="text-gray-400 hover:text-red-600 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
