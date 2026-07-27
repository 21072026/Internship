'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, LifeBuoy } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useT, useLocale } from '@/i18n/client';
import { relativeTime } from '@/lib/relativeTime';
import { SupportAttachmentList } from '@/components/SupportAttachmentList';
import {
  MessageBubble,
  MessageComposer,
  PendingAttachmentList,
  type PendingMessageAttachment,
} from '@/components/MessageThread';
import {
  SUPPORT_ATTACHMENT_ACCEPT,
  SUPPORT_ATTACHMENT_MAX_COUNT,
  type SupportAttachmentMeta,
  validateSupportFile,
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
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [me, setMe] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [attachments, setAttachments] = useState<PendingMessageAttachment[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () =>
    fetch('/api/support')
      .then((r) => (r.ok ? r.json() : { tickets: [] }))
      .then((d) => { setTickets(d.tickets ?? []); setMe(d.me ?? ''); })
      .catch(() => setTickets([]));

  useEffect(() => { load(); }, []);
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
    setErr('');
    const next = [...attachments];
    for (const file of Array.from(selected)) {
      const duplicate = next.some(({ file: current }) =>
        current.name === file.name && current.size === file.size &&
        current.type === file.type && current.lastModified === file.lastModified
      );
      if (duplicate) {
        setErr(s.attachmentDuplicate.replace('{name}', file.name));
        continue;
      }
      if (next.length >= SUPPORT_ATTACHMENT_MAX_COUNT) {
        setErr(s.attachmentTooMany.replace('{count}', String(SUPPORT_ATTACHMENT_MAX_COUNT)));
        break;
      }
      const validation = await validateSupportFile(file);
      if (validation) {
        const label = {
          unsupported: s.attachmentUnsupported,
          tooLarge: s.attachmentTooLarge,
          unreadable: s.attachmentUnreadable,
        }[validation];
        setErr(label.replace('{name}', file.name));
        continue;
      }
      next.push({ file, url: URL.createObjectURL(file) });
    }
    setAttachments(next);
    if (fileRef.current) fileRef.current.value = '';
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

      <div data-testid="support-chat">
        <Card className="mb-4">
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
  );
}
