'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, LifeBuoy, Send } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { relativeTime } from '@/lib/relativeTime';

interface SupportMsg { id: string; body: string; createdAt: string; senderId: string; sender: { fullName: string; role: string } }
interface Ticket { id: string; status: 'OPEN' | 'IN_PROGRESS' | 'CLOSED'; subject?: string | null; createdAt: string; closedAt?: string | null; messages: SupportMsg[] }

const STATUS_VARIANT: Record<Ticket['status'], 'info' | 'warning' | 'default'> = {
  OPEN: 'info',
  IN_PROGRESS: 'warning',
  CLOSED: 'default',
};

// The pinned "Support" conversation (#593) — the user's direct line to the
// admins. Shows the current ticket's thread plus past-ticket history with
// status badges; a message after a closed ticket opens a fresh one.
export default function SupportChatPage() {
  const t = useT();
  const s = t.support;
  const locale = useLocale();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [me, setMe] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = () =>
    fetch('/api/support')
      .then((r) => (r.ok ? r.json() : { tickets: [] }))
      .then((d) => { setTickets(d.tickets ?? []); setMe(d.me ?? ''); })
      .catch(() => setTickets([]));

  useEffect(() => { load(); }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [tickets]);

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });
      if (res.ok) {
        setBody('');
        await load();
      } else {
        setErr(t.common.error);
      }
    } catch {
      setErr(t.common.error);
    } finally {
      setBusy(false);
    }
  };

  const statusLabel: Record<Ticket['status'], string> = {
    OPEN: s.statusOpen, IN_PROGRESS: s.statusInProgress, CLOSED: s.statusClosed,
  };

  return (
    <div className="max-w-3xl">
      <Link href="/messages" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline mb-4">
        <ArrowLeft className="h-4 w-4" /> {t.messages.title}
      </Link>

      <div className="flex items-center gap-2 mb-1">
        <LifeBuoy className="h-6 w-6 text-blue-600" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{s.title}</h1>
      </div>
      <p className="text-gray-500 mb-6">{s.subtitle}</p>

      <Card data-testid="support-chat">
        {tickets === null ? (
          <p className="text-center py-10 text-gray-400">{t.common.loading}</p>
        ) : tickets.length === 0 ? (
          <p className="text-center py-10 text-gray-400">{s.empty}</p>
        ) : (
          <div className="space-y-6 max-h-[50vh] overflow-y-auto pr-1">
            {[...tickets].reverse().map((ticket) => (
              <div key={ticket.id} data-testid={`ticket-${ticket.id}`}>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={STATUS_VARIANT[ticket.status]} className="text-xs">{statusLabel[ticket.status]}</Badge>
                  <span className="text-xs text-gray-400">{relativeTime(new Date(ticket.createdAt), locale)}</span>
                </div>
                <div className="space-y-2">
                  {ticket.messages.map((m) => (
                    <div key={m.id} className={`flex ${m.senderId === me ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm whitespace-pre-line ${
                        m.senderId === me
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'
                      }`}>
                        {m.senderId !== me && <p className="text-[11px] font-medium opacity-70 mb-0.5">{s.teamLabel}</p>}
                        {m.body}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}

        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
          {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
          <div className="flex gap-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={s.placeholder}
              rows={2}
              maxLength={5000}
              className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
              data-testid="support-input"
            />
            <Button type="button" loading={busy} disabled={!body.trim()} onClick={send} data-testid="support-send">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
