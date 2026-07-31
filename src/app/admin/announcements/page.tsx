'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import {
  ANNOUNCEMENT_IMAGE_ACCEPT,
  ANNOUNCEMENT_IMAGE_MAX_BYTES,
  validateAnnouncementImage,
} from '@/lib/announcementImage';

interface AnnouncementRecord {
  id: string;
  text: string;
  link: string | null;
  imageUrl: string | null;
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
  const [image, setImage] = useState<{ file: File; url: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AnnouncementRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

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

  // The preview is an object URL, so it has to be released when the picked file
  // is replaced, cleared, or the page unmounts.
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  const clearImage = () => {
    setImage(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  // Validated client-side with the same rules the API applies, so a rejected
  // file is reported while the admin is still looking at the picker instead of
  // after they hit Broadcast.
  const pickImage = async (file: File) => {
    const invalid = await validateAnnouncementImage(file);
    if (fileRef.current) fileRef.current.value = '';
    if (invalid) {
      setError({
        unsupported: t.announcements.imageUnsupported,
        tooLarge: t.announcements.imageTooLarge.replace('{mb}', String(ANNOUNCEMENT_IMAGE_MAX_BYTES / (1024 * 1024))),
        unreadable: t.announcements.imageUnreadable,
      }[invalid]);
      return;
    }
    setError(null);
    setImage({ file, url: URL.createObjectURL(file) });
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setResult(null);
    setError(null);
    try {
      // multipart for every submit (the API also still accepts JSON) — one code
      // path whether or not an image is attached.
      const body = new FormData();
      body.append('text', text);
      if (link) body.append('link', link);
      body.append('email', String(email));
      if (image) body.append('image', image.file);

      const res = await fetch('/api/admin/announcements', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.common.error);
      setText(''); setLink(''); setEmail(false); clearImage();
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.announcements.title}</h1>
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
              <Textarea
                data-testid="announcement-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                required
                maxLength={TEXT_LIMITS.announcementText}
                showCounter
                placeholder={t.announcements.messagePlaceholder}
              />
            </div>
            <Input label={t.announcements.link} type="url" placeholder="https://..." maxLength={TEXT_LIMITS.announcementLink} value={link} onChange={(e) => setLink(e.target.value)} />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.announcements.image}</label>
              <input
                ref={fileRef}
                data-testid="announcement-image-input"
                type="file"
                accept={ANNOUNCEMENT_IMAGE_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pickImage(f);
                }}
              />
              {image ? (
                <div className="flex items-start gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt={image.file.name}
                    data-testid="announcement-image-preview"
                    className="h-24 w-24 rounded-lg object-cover border border-gray-200 dark:border-gray-700"
                  />
                  <div className="min-w-0">
                    <p className="text-xs text-gray-500 truncate">{image.file.name}</p>
                    <div className="flex gap-2 mt-1.5">
                      <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                        {t.announcements.imageReplace}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={clearImage}>
                        <X className="h-4 w-4 mr-1" />
                        {t.announcements.imageRemove}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                    <ImagePlus className="h-4 w-4 mr-1" />
                    {t.announcements.imageAdd}
                  </Button>
                  <p className="text-xs text-gray-400 mt-1.5">
                    {t.announcements.imageHint.replace('{mb}', String(ANNOUNCEMENT_IMAGE_MAX_BYTES / (1024 * 1024)))}
                  </p>
                </div>
              )}
            </div>

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
                  {a.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={a.imageUrl}
                      // Decorative here: the announcement text right above it is
                      // the content. A label like "Image (optional)" would just be
                      // noise for a screen reader.
                      alt=""
                      className="mt-2 max-h-40 rounded-lg border border-gray-200 dark:border-gray-700 object-contain"
                    />
                  )}
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
