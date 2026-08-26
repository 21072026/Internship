'use client';

import { useEffect, useRef, useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useT, useLocale } from '@/i18n/client';
import { relativeTime } from '@/lib/relativeTime';
import { SupportAttachmentList } from '@/components/SupportAttachmentList';
import { useMessagesHeaderTitle } from '@/components/MessagesShell';
import { useIsNarrow } from '@/hooks/useIsNarrow';
import { useRealtime } from '@/hooks/useRealtime';
import {
  MessageBubble,
  MessageComposer,
  PendingAttachmentList,
} from '@/components/MessageThread';
import {
  appendSupportAttachments,
  SUPPORT_ATTACHMENT_ACCEPT,
  type PendingSupportAttachment,
  type SupportAttachmentMeta,
} from '@/lib/supportAttachments';

interface SupportMsg { id: string; body: string; createdAt: string; senderId: string; sender: { fullName: string; role: string }; attachments: SupportAttachmentMeta[] }
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
  const narrow = useIsNarrow();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [me, setMe] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [attachments, setAttachments] = useState<PendingSupportAttachment[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useMessagesHeaderTitle(s.title);

  const load = () =>
    fetch('/api/support')
      .then((r) => (r.ok ? r.json() : { tickets: [] }))
      .then((d) => { setTickets(d.tickets ?? []); setMe(d.me ?? ''); })
      .catch(() => setTickets([]));

  useEffect(() => { load(); }, []);
  // An admin reply writes a `support.replied` notification, which reaches us on
  // the live stream (#1464) — so this thread refreshes itself like any other
  // instead of only on mount. `tick` covers the polling fallback.
  useRealtime((signal) => {
    if (signal.type === 'notification' || signal.type === 'tick') void load();
  });
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [tickets]);

  const send = async () => {
    const text = body.trim();
    if (!text && attachments.length === 0) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/support', {
        method: 'POST',
        body: (() => {
          const form = new FormData();
          form.append('body', text);
          attachments.forEach(({ file }) => form.append('files', file));
          return form;
        })(),
      });
      if (res.ok) {
        setBody('');
        attachments.forEach(({ url }) => URL.revokeObjectURL(url));
        setAttachments([]);
        if (fileRef.current) fileRef.current.value = '';
        await load();
      } else {
        setErr((await res.json().catch(() => null))?.error || t.common.error);
      }
    } catch {
      setErr(t.common.error);
    } finally {
      setBusy(false);
    }
  };

  const addFiles = async (selected: FileList | null) => {
    if (!selected?.length) return;
    const result = await appendSupportAttachments(attachments, selected, s);
    setAttachments(result.attachments);
    setErr(result.error);
    if (fileRef.current) fileRef.current.value = '';
  };

  const statusLabel: Record<Ticket['status'], string> = {
    OPEN: s.statusOpen, IN_PROGRESS: s.statusInProgress, CLOSED: s.statusClosed,
  };

  return (
    // Same full-height mobile frame as a normal thread: only the ticket history
    // scrolls, the composer stays put (see MessagesShell).
    <div className="flex h-full min-h-0 max-w-3xl flex-col lg:h-auto lg:block">
      {/* The shell header is the heading on mobile (see MessagesShell). */}
      {!narrow && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <LifeBuoy className="h-6 w-6 text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{s.title}</h1>
          </div>
          <p className="text-gray-500">{s.subtitle}</p>
        </div>
      )}

      <div data-testid="support-chat" className="flex min-h-0 flex-1 flex-col lg:block">
        <Card className="mb-3 flex min-h-0 flex-1 flex-col overflow-hidden p-3 lg:mb-4 lg:block lg:p-6">
          {tickets === null ? (
          <p className="text-center py-10 text-gray-400">{t.common.loading}</p>
        ) : tickets.length === 0 ? (
          <p className="text-center py-10 text-gray-400">{s.empty}</p>
        ) : (
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain pr-1 lg:max-h-[50vh] lg:flex-none">
            {[...tickets].reverse().map((ticket) => (
              <div key={ticket.id} data-testid={`ticket-${ticket.id}`}>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={STATUS_VARIANT[ticket.status]} className="text-xs">{statusLabel[ticket.status]}</Badge>
                  <span className="text-xs text-gray-400">{relativeTime(new Date(ticket.createdAt), locale)}</span>
                </div>
                <div className="space-y-2">
                  {ticket.messages.map((m) => (
                    <MessageBubble key={m.id} mine={m.senderId === me} senderLabel={m.senderId !== me ? s.teamLabel : undefined}>
                        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                        <SupportAttachmentList attachments={m.attachments ?? []} />
                    </MessageBubble>
                  ))}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          )}
        </Card>

        <div className="shrink-0">
        {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
        <PendingAttachmentList
          attachments={attachments}
          removeLabel={s.removeAttachment}
          onRemove={(index) => setAttachments((current) => {
            const next = [...current];
            const [removed] = next.splice(index, 1);
            if (removed) URL.revokeObjectURL(removed.url);
            return next;
          })}
        />
        <MessageComposer
          body={body}
          onBodyChange={setBody}
          onSubmit={send}
          sending={busy}
          hasAttachments={attachments.length > 0}
          placeholder={s.placeholder}
          sendLabel={t.messages.send}
          attachLabel={s.attach}
          fileInputRef={fileRef}
          accept={SUPPORT_ATTACHMENT_ACCEPT}
          onFilesSelected={(selected) => void addFiles(selected)}
          textareaTestId="support-input"
          inputTestId="support-file-input"
          attachTestId="support-attach"
          sendTestId="support-send"
        />
        </div>
      </div>
    </div>
  );
}
