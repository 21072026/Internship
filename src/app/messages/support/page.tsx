'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, FileText, LifeBuoy, Paperclip, Send, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { relativeTime } from '@/lib/relativeTime';
import { SupportAttachmentList } from '@/components/SupportAttachmentList';
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
  const [files, setFiles] = useState<File[]>([]);
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
    if (!text) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/support', {
        method: 'POST',
        body: (() => {
          const form = new FormData();
          form.append('body', text);
          files.forEach((file) => form.append('files', file));
          return form;
        })(),
      });
      if (res.ok) {
        setBody('');
        setFiles([]);
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
    const next = [...files];
    for (const file of Array.from(selected)) {
      const duplicate = next.some((current) =>
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
      next.push(file);
    }
    setFiles(next);
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
                        <SupportAttachmentList attachments={m.attachments ?? []} />
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
          {files.length > 0 && (
            <ul className="mb-3 grid gap-2 sm:grid-cols-2" aria-label={s.selectedAttachments}>
              {files.map((file) => {
                const image = file.type.startsWith('image/');
                const preview = image ? URL.createObjectURL(file) : '';
                return (
                  <li key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                    {image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={preview} onLoad={() => URL.revokeObjectURL(preview)} alt="" className="h-12 w-12 rounded object-cover" />
                    ) : <FileText className="h-8 w-8 text-red-500" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{file.name}</span>
                      <span className="block text-[11px] text-gray-500">{file.type} · {Math.max(1, Math.round(file.size / 1024))} KB</span>
                    </span>
                    <button type="button" onClick={() => setFiles((current) => current.filter((item) => item !== file))} aria-label={`${s.removeAttachment}: ${file.name}`} className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-800">
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={s.placeholder}
              rows={2}
              maxLength={5000}
              className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
              data-testid="support-input"
            />
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={SUPPORT_ATTACHMENT_ACCEPT}
              className="sr-only"
              onChange={(event) => addFiles(event.target.files)}
              data-testid="support-file-input"
            />
            <Button type="button" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="support-attach">
              <Paperclip className="h-4 w-4 mr-1" /> {s.attach}
            </Button>
            <Button type="button" loading={busy} disabled={!body.trim()} onClick={send} data-testid="support-send">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
