'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

interface Msg {
  id: string;
  senderId: string;
  body: string;
  channel: 'IN_APP' | 'EMAIL';
  readAt: string | null;
  createdAt: string;
}
interface Party { id: string; fullName: string }

export default function ThreadPage({ params }: { params: Promise<{ relationId: string }> }) {
  const { relationId } = use(params);
  const t = useT();
  const { data: session } = useSession();
  const myId = session?.user?.id;
  const [messages, setMessages] = useState<Msg[]>([]);
  const [mentor, setMentor] = useState<Party | null>(null);
  const [mentee, setMentee] = useState<Party | null>(null);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/messages?relationId=${relationId}`);
    if (res.status === 403) { setForbidden(true); setLoading(false); return; }
    const d = await res.json();
    setMessages(d.messages ?? []);
    setMentor(d.mentor ?? null);
    setMentee(d.mentee ?? null);
    setLoading(false);
  }, [relationId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, body }),
      });
      if (res.ok) { setBody(''); await load(); }
    } finally {
      setSending(false);
    }
  };

  if (loading) return <p className="text-center py-12 text-gray-400">{t.common.loading}</p>;
  if (forbidden) return <p className="text-center py-12 text-gray-400">{t.common.notFound}</p>;

  const nameFor = (id: string) =>
    id === mentor?.id ? mentor?.fullName : id === mentee?.id ? mentee?.fullName : '—';
  const other = myId === mentor?.id ? mentee : mentor;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">{t.messages.title}</h1>
      <p className="text-gray-500 mb-6">{other?.fullName}</p>

      <Card className="mb-4">
        {messages.length === 0 ? (
          <p className="text-center py-10 text-gray-400 text-sm">{t.messages.empty}</p>
        ) : (
          <div className="space-y-3 max-h-[55vh] overflow-y-auto">
            {messages.map((m, i) => {
              const mine = m.senderId === myId;
              // Show a read receipt on my latest message only.
              const isMyLast = mine && !messages.slice(i + 1).some((x) => x.senderId === myId);
              return (
                <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${mine ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'}`}>
                    {!mine && <p className="text-xs font-medium mb-0.5 opacity-70">{nameFor(m.senderId)}</p>}
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    <p className={`text-[10px] mt-1 ${mine ? 'text-blue-100' : 'text-gray-400'}`}>
                      {m.channel === 'EMAIL' ? '✉ ' : ''}{new Date(m.createdAt).toLocaleString()}
                      {isMyLast && <span className="ml-1">· {m.readAt ? t.messages.read : t.messages.sent}</span>}
                    </p>
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </Card>

      <form onSubmit={send} className="flex gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder={t.messages.replyPlaceholder}
          className="flex-1 rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 resize-none"
        />
        <Button type="submit" loading={sending} disabled={!body.trim()}>{t.messages.send}</Button>
      </form>
    </div>
  );
}
