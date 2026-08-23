'use client';

import { use, useEffect, useState } from 'react';
import { GraduationCap, CheckCircle2 } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

export default function ApplyPage({ params }: { params: Promise<{ mentorId: string }> }) {
  const { mentorId } = use(params);
  const t = useT();
  const [mentorName, setMentorName] = useState<string | null | undefined>(undefined);
  // Whether the link is open (#1188): a full or paused mentor's link explains
  // itself BEFORE any form is shown — never an empty form that fails on submit.
  const [accepting, setAccepting] = useState(true);
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', city: '', university: '', department: '', skills: '' });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    fetch(`/api/apply?mentorId=${encodeURIComponent(mentorId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setMentorName(d?.mentorName ?? null);
        setAccepting(d?.accepting !== false);
      })
      .catch(() => setMentorName(null));
  }, [mentorId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mentorId, ...form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="flex justify-center mb-6">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center">
            <GraduationCap className="h-8 w-8 text-white" />
          </div>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          {mentorName === undefined ? (
            <p className="text-gray-500 text-center">…</p>
          ) : mentorName === null ? (
            <p className="text-gray-500 text-center">{t.apply.invalid}</p>
          ) : done ? (
            <div className="text-center">
              <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-3" />
              <h1 className="text-xl font-bold text-gray-900 mb-1">{t.apply.thanksTitle}</h1>
              <p className="text-gray-500 text-sm">{t.apply.thanksBody}</p>
            </div>
          ) : !accepting ? (
            <div className="text-center" data-testid="apply-closed">
              <h1 className="text-xl font-bold text-gray-900 mb-2">{t.apply.fullTitle}</h1>
              <p className="text-gray-500 text-sm">{t.apply.fullBody.replace('{mentor}', mentorName)}</p>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-gray-900 text-center">{t.apply.title}</h1>
              <p className="text-gray-500 mt-1 mb-6 text-center">
                {t.apply.subtitle.replace('{mentor}', mentorName)}
              </p>
              {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
              <form onSubmit={submit} className="space-y-4">
                <Input label={t.apply.fullName} required value={form.fullName} onChange={(e) => set('fullName', e.target.value)} />
                <Input label={t.apply.email} type="email" required value={form.email} onChange={(e) => set('email', e.target.value)} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input label={t.apply.phone} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
                  <Input label={t.apply.city} value={form.city} onChange={(e) => set('city', e.target.value)} />
                  <Input label={t.apply.university} value={form.university} onChange={(e) => set('university', e.target.value)} />
                  <Input label={t.apply.department} value={form.department} onChange={(e) => set('department', e.target.value)} />
                </div>
                <Input label={t.apply.skills} placeholder="React, Python…" value={form.skills} onChange={(e) => set('skills', e.target.value)} />
                <Button type="submit" className="w-full" size="lg" loading={sending}>
                  {t.apply.submit}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
