'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

export default function AdminAnnouncementsPage() {
  const t = useT();
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [email, setEmail] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch('/api/admin/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, link: link || undefined, email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.common.error);
      setText(''); setLink(''); setEmail(false);
      setResult(t.announcements.sent.replace('{n}', String(data.recipients)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.announcements.title}</h1>
        <p className="text-gray-500 mt-1">{t.announcements.subtitle}</p>
      </div>

      {result && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">✓ {result}</div>}
      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      <Card className="max-w-2xl">
        <CardHeader><CardTitle>{t.announcements.newAnnouncement}</CardTitle></CardHeader>
        <form onSubmit={send} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.announcements.message}</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              required
              className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
              placeholder={t.announcements.messagePlaceholder}
            />
          </div>
          <Input label={t.announcements.link} type="url" placeholder="https://..." value={link} onChange={(e) => setLink(e.target.value)} />
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
            {t.announcements.alsoEmail}
          </label>
          <Button type="submit" loading={sending}>{t.announcements.send}</Button>
        </form>
      </Card>
    </div>
  );
}
