'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Paperclip, X, FileText, Download } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}
interface Msg {
  id: string;
  senderId: string;
  body: string;
  channel: 'IN_APP' | 'EMAIL';
  readAt: string | null;
  createdAt: string;
  attachments: Attachment[];
}
interface Party { id: string; fullName: string }

export default function ThreadPage({ params }: { params: Promise<{ relationId: string }> }) {
  const { relationId } = use(params);
  const t = useT();
  const locale = useLocale();
  const { data: session } = useSession();
  const myId = session?.user?.id;
  const [messages, setMessages] = useState<Msg[]>([]);
  const [mentor, setMentor] = useState<Party | null>(null);
  const [mentee, setMentee] = useState<Party | null>(null);
  const [body, setBody] = useState('');
  // Pending attachments (picked files + pasted images), each with an object URL
  // for an instant thumbnail/preview. Uploaded with the message on send.
  const [attachments, setAttachments] = useState<{ file: File; url: string }[]>([]);
  const [attachError, setAttachError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const addFiles = (list: FileList | File[]) => {
    const picked = Array.from(list).filter(Boolean);
    if (picked.length === 0) return;
    setAttachments((prev) => [...prev, ...picked.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => {
      const next = [...prev];
      const [gone] = next.splice(idx, 1);
      if (gone) URL.revokeObjectURL(gone.url);
      return next;
    });
  };

  // Paste an image straight from the clipboard into the reply box.
  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
      // Clipboard images are often named "image.png"; make them unique.
      .map((f) => new File([f], `pasted-${messages.length}-${f.name || 'image.png'}`, { type: f.type }));
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() && attachments.length === 0) return;
    setSending(true);
    setAttachError('');
    try {
      let res: Response;
      if (attachments.length > 0) {
        const fd = new FormData();
        fd.append('relationId', relationId);
        fd.append('body', body);
        attachments.forEach((a) => fd.append('file', a.file));
        res = await fetch('/api/messages', { method: 'POST', body: fd });
      } else {
        res = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relationId, body }),
        });
      }
      if (res.ok) {
        setBody('');
        attachments.forEach((a) => URL.revokeObjectURL(a.url));
        setAttachments([]);
        if (fileRef.current) fileRef.current.value = '';
        await load();
      } else {
        const data = await res.json().catch(() => ({}));
        setAttachError(data.error || t.messages.sendFailed);
      }
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
                    {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                    {m.attachments.map((a) =>
                      a.contentType.startsWith('image/') ? (
                        <a key={a.id} href={`/api/messages/attachments/${a.id}`} target="_blank" rel="noopener noreferrer" className="block mt-1.5">
                          <img src={`/api/messages/attachments/${a.id}`} alt={a.filename} className="max-h-48 rounded-lg" />
                        </a>
                      ) : (
                        <a
                          key={a.id}
                          href={`/api/messages/attachments/${a.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`flex items-center gap-1.5 mt-1.5 text-xs rounded-lg px-2 py-1.5 ${mine ? 'bg-blue-700 hover:bg-blue-800' : 'bg-white hover:bg-gray-50 border border-gray-200'}`}
                        >
                          <FileText className="h-3.5 w-3.5 flex-shrink-0" />
                          <span className="truncate">{a.filename}</span>
                          <Download className="h-3 w-3 flex-shrink-0 ml-auto" />
                        </a>
                      )
                    )}
                    <p className={`text-[10px] mt-1 ${mine ? 'text-blue-100' : 'text-gray-400'}`}>
                      {m.channel === 'EMAIL' ? '✉ ' : ''}{formatDateTime(m.createdAt, locale)}
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

      {attachError && <p className="text-xs text-red-600 mb-2">{attachError}</p>}
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-start gap-2 mb-2">
          {attachments.map((a, idx) => (
            <div key={a.url} className="relative group">
              {a.file.type.startsWith('image/') ? (
                <a href={a.url} target="_blank" rel="noopener noreferrer" title={a.file.name}>
                  <img src={a.url} alt={a.file.name} className="h-16 w-16 object-cover rounded-lg border border-gray-200" />
                </a>
              ) : (
                <div className="flex items-center gap-2 text-xs bg-gray-100 rounded-lg px-2.5 py-1.5 h-16">
                  <FileText className="h-3.5 w-3.5 text-gray-500" />
                  <span className="text-gray-700 max-w-[8rem] truncate">{a.file.name}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(idx)}
                aria-label={t.common.delete}
                className="absolute -top-1.5 -right-1.5 bg-white rounded-full border border-gray-200 text-gray-400 hover:text-red-600 shadow-sm"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={send} className="flex gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          data-testid="message-attachment-input"
          accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg"
          className="hidden"
          onChange={(e) => { if (e.target.files) addFiles(e.target.files); }}
        />
        <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} aria-label={t.messages.attach} title={t.messages.attach}>
          <Paperclip className="h-4 w-4" />
        </Button>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPaste={onPaste}
          rows={2}
          placeholder={t.messages.replyPlaceholder}
          className="flex-1 rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 resize-none"
        />
        <Button type="submit" loading={sending} disabled={!body.trim() && attachments.length === 0}>{t.messages.send}</Button>
      </form>
    </div>
  );
}
