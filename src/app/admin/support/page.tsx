'use client';

import { useCallback, useEffect, useState } from 'react';
import { LifeBuoy, Send, UserPlus } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { relativeTime } from '@/lib/relativeTime';
import { SupportAttachmentList } from '@/components/SupportAttachmentList';
import type { SupportAttachmentMeta } from '@/lib/supportAttachments';

type Status = 'OPEN' | 'IN_PROGRESS' | 'CLOSED';

interface Msg { id: string; body: string; createdAt: string; senderId: string; readAt?: string | null; sender: { fullName: string; role: string }; attachments: SupportAttachmentMeta[] }
interface Ticket {
  id: string;
  status: Status;
  subject?: string | null;
  createdAt: string;
  updatedAt: string;
  requester: { id: string; fullName: string; email: string; role: string };
  assignedAdmin?: { id: string; fullName: string } | null;
  messages: Msg[];
}

const STATUS_VARIANT: Record<Status, 'info' | 'warning' | 'default'> = {
  OPEN: 'info', IN_PROGRESS: 'warning', CLOSED: 'default',
};

// Admin support queue (#594): every ticket across the platform, filterable by
// status, with inline reply, status transitions and take-assignment.
export default function AdminSupportPage() {
  const t = useT();
  const s = t.support;
  const a = t.adminSupport;
  const locale = useLocale();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [me, setMe] = useState('');
  const [filter, setFilter] = useState<Status | ''>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(
    (status: Status | '' = filter) =>
      fetch(`/api/admin/support${status ? `?status=${status}` : ''}`)
        .then((r) => (r.ok ? r.json() : { tickets: [] }))
        .then((d) => { setTickets(d.tickets ?? []); setMe(d.me ?? ''); })
        .catch(() => setTickets([])),
    [filter]
  );

  useEffect(() => { load(); }, [load]);

  const statusLabel: Record<Status, string> = {
    OPEN: s.statusOpen, IN_PROGRESS: s.statusInProgress, CLOSED: s.statusClosed,
  };

  const sendReply = async (ticketId: string) => {
    const body = reply.trim();
    if (!body) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/admin/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, body }),
      });
      if (res.ok) { setReply(''); await load(); } else setErr(t.common.error);
    } catch {
      setErr(t.common.error);
    } finally {
      setBusy(false);
    }
  };

  const update = async (ticketId: string, data: { status?: Status; assignToMe?: boolean }) => {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/admin/support', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, ...data }),
      });
      if (res.ok) await load();
      else setErr(t.common.error);
    } catch {
      setErr(t.common.error);
    } finally {
      setBusy(false);
    }
  };

  const unreadCount = (tk: Ticket) => tk.messages.filter((m) => m.senderId === tk.requester.id && !m.readAt).length;

  const FILTERS: { value: Status | ''; label: string }[] = [
    { value: '', label: a.filterAll },
    { value: 'OPEN', label: s.statusOpen },
    { value: 'IN_PROGRESS', label: s.statusInProgress },
    { value: 'CLOSED', label: s.statusClosed },
  ];

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <LifeBuoy className="h-6 w-6 text-blue-600" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{a.title}</h1>
      </div>
      <p className="text-gray-500 mb-6">{a.subtitle}</p>

      <div className="flex gap-2 mb-4" data-testid="support-filters">
        {FILTERS.map((f) => (
          <button
            key={f.value || 'all'}
            type="button"
            onClick={() => { setFilter(f.value); setOpenId(null); }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-gray-700'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {err && <p className="text-sm text-red-600 mb-3">{err}</p>}

      {tickets === null ? (
        <p className="text-center py-10 text-gray-400">{t.common.loading}</p>
      ) : tickets.length === 0 ? (
        <Card><p className="text-center py-10 text-gray-400">{a.empty}</p></Card>
      ) : (
        <div className="space-y-3">
          {tickets.map((tk) => {
            const expanded = openId === tk.id;
            const unread = unreadCount(tk);
            return (
              <Card key={tk.id} data-testid={`admin-ticket-${tk.id}`}>
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => { setOpenId(expanded ? null : tk.id); setReply(''); }}
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 dark:text-gray-100 truncate">
                        {tk.requester.fullName}
                        <span className="ml-2 text-xs text-gray-400 font-normal">{tk.requester.email}</span>
                      </p>
                      <p className="text-sm text-gray-500 truncate">{tk.subject ?? '—'}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {unread > 0 && (
                        <Badge variant="danger" className="text-xs" data-testid="unread-badge">{unread}</Badge>
                      )}
                      <Badge variant={STATUS_VARIANT[tk.status]} className="text-xs">{statusLabel[tk.status]}</Badge>
                      <span className="text-xs text-gray-400">{relativeTime(new Date(tk.updatedAt), locale)}</span>
                    </div>
                  </div>
                </button>

                {expanded && (
                  <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
                    <div className="flex items-center gap-2 mb-3 text-xs text-gray-500">
                      <span>
                        {tk.assignedAdmin
                          ? `${a.assignedTo} ${tk.assignedAdmin.fullName}`
                          : a.unassigned}
                      </span>
                      {(!tk.assignedAdmin || tk.assignedAdmin.id !== me) && (
                        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => update(tk.id, { assignToMe: true })} data-testid="assign-me">
                          <UserPlus className="h-3.5 w-3.5 mr-1" /> {a.assignToMe}
                        </Button>
                      )}
                    </div>

                    <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1 mb-3">
                      {tk.messages.map((m) => (
                        <div key={m.id} className={`flex ${m.senderId === tk.requester.id ? 'justify-start' : 'justify-end'}`}>
                          <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm whitespace-pre-line ${
                            m.senderId === tk.requester.id
                              ? 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'
                              : 'bg-blue-600 text-white'
                          }`}>
                            <p className="text-[11px] font-medium opacity-70 mb-0.5">{m.sender.fullName}</p>
                            {m.body}
                            <SupportAttachmentList attachments={m.attachments ?? []} />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="flex gap-2 mb-3">
                      <textarea
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        placeholder={a.replyPlaceholder}
                        rows={2}
                        maxLength={5000}
                        className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
                        data-testid="admin-reply-input"
                      />
                      <Button type="button" loading={busy} disabled={!reply.trim()} onClick={() => sendReply(tk.id)} data-testid="admin-reply-send">
                        <Send className="h-4 w-4" />
                      </Button>
                    </div>

                    <div className="flex gap-2 flex-wrap">
                      {tk.status !== 'IN_PROGRESS' && tk.status !== 'CLOSED' && (
                        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => update(tk.id, { status: 'IN_PROGRESS' })} data-testid="mark-in-progress">
                          {a.markInProgress}
                        </Button>
                      )}
                      {tk.status !== 'CLOSED' ? (
                        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => update(tk.id, { status: 'CLOSED' })} data-testid="close-ticket">
                          {a.closeTicket}
                        </Button>
                      ) : (
                        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => update(tk.id, { status: 'OPEN' })} data-testid="reopen-ticket">
                          {a.reopenTicket}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
