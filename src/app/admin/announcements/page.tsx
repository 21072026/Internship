'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

interface AnnouncementRecord {
  id: string;
  text: string;
  link: string | null;
  sentByName: string | null;
  recipientCount: number;
  emailedCount: number;
  createdAt: string;
}

export default function AdminAnnouncementsPage() {
  const t = useT();
  const locale = useLocale();
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [email, setEmail] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AnnouncementRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/admin/announcements');
      const data = await res.json();
      setHistory(data.announcements || []);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

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
      await fetchHistory();
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
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

        <Card>
          <CardHeader><CardTitle>{t.announcements.history}</CardTitle></CardHeader>
          {historyLoading ? (
            <SkeletonRows rows={4} />
          ) : history.length === 0 ? (
            <p className="text-sm text-gray-400">{t.announcements.noHistory}</p>
          ) : (
            <div className="space-y-3 max-h-[32rem] overflow-y-auto">
              {history.map((a) => (
                <div key={a.id} data-testid={`announcement-${a.id}`} className="p-3 bg-gray-50 rounded-lg border border-gray-100">
                  <p className="text-sm text-gray-900 whitespace-pre-wrap">{a.text}</p>
                  {a.link && (
                    <a href={a.link} target={a.link.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline block mt-1">
                      {a.link}
                    </a>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-2 text-xs text-gray-500">
                    <span>{formatDateTime(a.createdAt, locale)}</span>
                    {a.sentByName && <span>{t.announcements.sentBy.replace('{name}', a.sentByName)}</span>}
                    <span>{t.announcements.recipients.replace('{n}', String(a.recipientCount))}</span>
                    {a.emailedCount > 0 && <span>{t.announcements.emailedCount.replace('{n}', String(a.emailedCount))}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
