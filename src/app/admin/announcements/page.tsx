'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, X, Pencil, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import {
  ANNOUNCEMENT_IMAGE_ACCEPT,
  ANNOUNCEMENT_IMAGE_MAX_BYTES,
  validateAnnouncementImage,
} from '@/lib/announcementImage';
import { locales, type Locale } from '@/i18n/config';
import { objectUrlSrc } from '@/lib/objectUrl';

type Bodies = Partial<Record<Locale, string>>;

/** The languages a draft has actually been written in. */
const filledLocales = (bodies: Bodies) => locales.filter((l) => !!bodies[l]?.trim());

interface AnnouncementRecord {
  id: string;
  text: string;
  // { en?, tr?, de? } — the languages this announcement was written in (#1163).
  // Empty for a single-language one sent before (or without) translations.
  translations: Bodies;
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
  // One announcement, up to three languages (#1163). The composer keeps a body
  // per language and a tab for the one being typed; each reader is served their
  // own, falling back to whichever was written.
  const [bodies, setBodies] = useState<Bodies>({});
  const [tab, setTab] = useState<Locale>(locale);
  const [link, setLink] = useState('');
  const [email, setEmail] = useState(false);
  const [image, setImage] = useState<{ file: File; url: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AnnouncementRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  // Editing a published announcement (#1162): which row is open, and the draft
  // being typed into it. An edit corrects the record — it never re-broadcasts.
  const [editId, setEditId] = useState<string | null>(null);
  const [editBodies, setEditBodies] = useState<Bodies>({});
  const [editTab, setEditTab] = useState<Locale>(locale);
  const [editLink, setEditLink] = useState('');
  const [editDropImage, setEditDropImage] = useState(false);
  const [rowBusy, setRowBusy] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

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

  // Paste an image straight from the clipboard into the composer — the same
  // gesture the message composer supports (MessageThreadView). A screenshot is
  // the most common thing an admin attaches to an announcement, and going
  // through "save to disk, then pick the file" for it is pure friction.
  const onPaste = (e: React.ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .find((file): file is File => !!file);
    if (!pasted) return; // plain text paste — leave it to the textarea
    e.preventDefault();
    // Clipboard images arrive as "image.png" or unnamed; the name is only shown
    // next to the preview, but a timestamp keeps two pastes distinguishable.
    pickImage(new File([pasted], `pasted-${Date.now()}.png`, { type: pasted.type }));
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    // At least one language must carry a message; the rest may stay empty.
    if (filledLocales(bodies).length === 0) return;
    setSending(true);
    setResult(null);
    setError(null);
    try {
      // multipart for every submit (the API also still accepts JSON) — one code
      // path whether or not an image is attached.
      const body = new FormData();
      body.append('translations', JSON.stringify(bodies));
      if (link) body.append('link', link);
      body.append('email', String(email));
      if (image) body.append('image', image.file);

      const res = await fetch('/api/admin/announcements', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.common.error);
      setBodies({}); setLink(''); setEmail(false); clearImage();
      setResult(t.announcements.sent.replace('{n}', String(data.recipients)));
      await fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setSending(false);
    }
  };

  const startEdit = (a: AnnouncementRecord) => {
    setError(null);
    setResult(null);
    setEditId(a.id);
    // A row sent before translations existed has only the canonical `text` —
    // seed it under the reader's current language so an edit does not silently
    // drop the original wording.
    const existing = filledLocales(a.translations).length > 0 ? a.translations : { [locale]: a.text };
    setEditBodies(existing);
    setEditTab(filledLocales(existing)[0] ?? locale);
    setEditLink(a.link ?? '');
    setEditDropImage(false);
  };

  const cancelEdit = () => {
    setEditId(null);
    setEditDropImage(false);
  };

  const saveEdit = async () => {
    if (!editId || filledLocales(editBodies).length === 0) return;
    setRowBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/announcements/${editId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          translations: editBodies,
          ...(editLink ? { link: editLink } : {}),
          ...(editDropImage ? { imageAction: 'remove' } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.common.error);
      cancelEdit();
      setResult(t.announcements.updated);
      await fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setRowBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    setRowBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/announcements/${deleteId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? t.common.error);
      }
      if (editId === deleteId) cancelEdit();
      setDeleteId(null);
      setResult(t.announcements.deleted);
      await fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.error);
    } finally {
      setRowBusy(false);
    }
  };

  // A row of language tabs with a dot on the ones already written. Long-form
  // bodies do not fit side by side the way the goal-template titles do
  // (src/app/admin/goal-templates/page.tsx), so the languages take turns in one
  // box instead — and the dots keep "which have I filled in?" answerable at a
  // glance.
  const languageTabs = (bodies: Bodies, active: Locale, onPick: (l: Locale) => void, idPrefix: string) => (
    <div className="flex gap-1" role="tablist">
      {locales.map((l) => {
        const filled = !!bodies[l]?.trim();
        return (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={active === l}
            data-testid={`${idPrefix}-tab-${l}`}
            data-filled={filled ? 'true' : 'false'}
            onClick={() => onPick(l)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold uppercase ${
              active === l
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:!bg-gray-800 dark:!text-gray-300'
            }`}
          >
            {l}
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${
                filled ? (active === l ? 'bg-white' : 'bg-green-500') : 'bg-transparent border border-current opacity-40'
              }`}
            />
          </button>
        );
      })}
    </div>
  );

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
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <label className="block text-sm font-medium text-gray-700">{t.announcements.message}</label>
                {languageTabs(bodies, tab, setTab, 'announcement')}
              </div>
              <Textarea
                data-testid="announcement-text"
                value={bodies[tab] ?? ''}
                onChange={(e) => setBodies((prev) => ({ ...prev, [tab]: e.target.value }))}
                onPaste={onPaste}
                rows={4}
                maxLength={TEXT_LIMITS.announcementText}
                showCounter
                placeholder={t.announcements.messagePlaceholder}
              />
              {/* Everyone gets a message either way; this says which language
                  the ones you skipped will read. */}
              <p className="mt-1.5 text-xs text-gray-400">
                {filledLocales(bodies).length === 0
                  ? t.announcements.langHint
                  : t.announcements.langFallback.replace(
                      '{lang}',
                      (filledLocales(bodies)[0] ?? '').toUpperCase()
                    )}
              </p>
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
                    src={objectUrlSrc(image.url)}
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
                  {editId === a.id ? (
                    <div className="space-y-2">
                      {languageTabs(editBodies, editTab, setEditTab, 'announcement-edit')}
                      <Textarea
                        data-testid="announcement-edit-text"
                        value={editBodies[editTab] ?? ''}
                        onChange={(e) => setEditBodies((prev) => ({ ...prev, [editTab]: e.target.value }))}
                        rows={4}
                        maxLength={TEXT_LIMITS.announcementText}
                        showCounter
                      />
                      <Input
                        data-testid="announcement-edit-link"
                        type="url"
                        placeholder="https://..."
                        maxLength={TEXT_LIMITS.announcementLink}
                        value={editLink}
                        onChange={(e) => setEditLink(e.target.value)}
                      />
                      {a.imageUrl && (
                        <label className="flex items-center gap-2 text-xs text-gray-600">
                          <input
                            type="checkbox"
                            data-testid="announcement-edit-drop-image"
                            checked={editDropImage}
                            onChange={(e) => setEditDropImage(e.target.checked)}
                          />
                          {t.announcements.removeImage}
                        </label>
                      )}
                      {/* An edit corrects the record; it does not send again.
                          Saying so here stops "fix a typo" from feeling like it
                          will ping everyone a second time. */}
                      <p className="text-xs text-gray-400">{t.announcements.editNoResend}</p>
                      <div className="flex gap-2">
                        <Button size="sm" data-testid="announcement-edit-save" loading={rowBusy} onClick={saveEdit}>
                          {t.common.save}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={rowBusy}>
                          {t.common.cancel}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-900 whitespace-pre-wrap">{a.text}</p>
                  )}
                  {editId !== a.id && a.imageUrl && (
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
                    {editId !== a.id && (
                      <span className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          data-testid={`announcement-edit-${a.id}`}
                          onClick={() => startEdit(a)}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-gray-200 hover:text-gray-700"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          {t.common.edit}
                        </button>
                        <button
                          type="button"
                          data-testid={`announcement-delete-${a.id}`}
                          onClick={() => setDeleteId(a.id)}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t.common.delete}
                        </button>
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Deleting also removes the notification rows this broadcast created, so
          the confirmation says so rather than implying only the log entry goes. */}
      <ConfirmDialog
        open={deleteId !== null}
        title={t.announcements.deleteTitle}
        message={t.announcements.deleteConfirm}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        variant="danger"
        loading={rowBusy}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
