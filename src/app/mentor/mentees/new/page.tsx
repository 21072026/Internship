'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { ArrowLeft } from 'lucide-react';
import { useT } from '@/i18n/client';

export default function NewMenteePage() {
  const t = useT();
  const router = useRouter();
  const [form, setForm] = useState({
    fullName: '', email: '', phone: '', whatsapp: '', city: '', university: '', department: '', referralSource: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [setPasswordUrl, setSetPasswordUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Possible-duplicate matches returned by the API's 409 pre-flight (#841).
  const [duplicates, setDuplicates] = useState<
    { id: string; fullName: string; email: string; university: string | null; signals: string[] }[]
  >([]);

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const doSubmit = async (confirmDuplicate: boolean) => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/mentor/mentees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmDuplicate ? { ...form, confirmDuplicate: true } : form),
      });
      const data = await res.json();
      // The API warns about look-alike candidates before creating; the mentor
      // can review, edit the form, or explicitly create anyway.
      if (res.status === 409 && data.error === 'possible_duplicate') {
        setDuplicates(data.possibleDuplicates ?? []);
        setSaving(false);
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Failed');
      setDuplicates([]);
      // With a real email, show the set-password link so the mentor can share
      // it if the email doesn't arrive; otherwise go straight to the list.
      if (data.setPasswordUrl) {
        setSetPasswordUrl(data.setPasswordUrl);
        setSaving(false);
      } else {
        router.push('/mentor/mentees');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setSaving(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await doSubmit(false);
  };

  const signalLabel = (s: string) =>
    t.duplicates.signals[s as keyof typeof t.duplicates.signals] ?? s;

  if (setPasswordUrl) {
    return (
      <div>
        <Link href="/mentor/mentees" className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft className="h-4 w-4" />
          {t.mentor.backToMentees}
        </Link>
        <Card className="max-w-2xl">
          <CardHeader><CardTitle>{t.mentor.menteeCreated}</CardTitle></CardHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">{t.mentor.setPwLinkHint}</p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={setPasswordUrl}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-50 text-gray-700"
                onFocus={(e) => e.target.select()}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  navigator.clipboard?.writeText(setPasswordUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? t.mentor.copied : t.mentor.copyLink}
              </Button>
            </div>
            <Button type="button" onClick={() => router.push('/mentor/mentees')}>
              {t.mentor.backToMentees}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <Link href="/mentor/mentees" className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="h-4 w-4" />
        {t.mentor.backToMentees}
      </Link>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.mentor.newMentee}</h1>
      </div>

      <Card className="max-w-2xl">
        <CardHeader><CardTitle>{t.mentor.addMentee}</CardTitle></CardHeader>
        {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
        {duplicates.length > 0 && (
          <div data-testid="possible-duplicates" className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
            <p className="font-medium text-amber-800">{t.duplicates.possibleDuplicatesTitle}</p>
            <p className="text-amber-700 mt-1">{t.duplicates.possibleDuplicatesHint}</p>
            <ul className="mt-2 space-y-1">
              {duplicates.map((d) => (
                <li key={d.id} className="text-amber-800">
                  <span className="font-medium">{d.fullName}</span>
                  {d.email ? <span className="text-amber-700"> · {d.email}</span> : null}
                  {d.university ? <span className="text-amber-700"> · {d.university}</span> : null}
                  <span className="text-amber-700"> — {t.duplicates.matchedOn}: {d.signals.map(signalLabel).join(', ')}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <Button type="button" variant="secondary" loading={saving} onClick={() => doSubmit(true)}>
                {t.duplicates.createAnyway}
              </Button>
              <Button type="button" variant="outline" onClick={() => setDuplicates([])}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        )}
        <form onSubmit={submit} className="space-y-4">
          <Input label={t.mentor.fullName} required value={form.fullName} onChange={(e) => set('fullName', e.target.value)} />
          <Input label={t.mentor.emailOptional} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label={t.mentor.phone} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
            <Input label={t.mentor.whatsapp} value={form.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} />
            <Input label={t.mentor.city} value={form.city} onChange={(e) => set('city', e.target.value)} />
            <Input label={t.mentor.university} value={form.university} onChange={(e) => set('university', e.target.value)} />
            <Input label={t.mentor.department} value={form.department} onChange={(e) => set('department', e.target.value)} />
            <Input label={t.mentor.referral} value={form.referralSource} onChange={(e) => set('referralSource', e.target.value)} />
          </div>
          <Button type="submit" loading={saving}>{t.mentor.create}</Button>
        </form>
      </Card>
    </div>
  );
}
