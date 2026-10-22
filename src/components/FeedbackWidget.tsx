'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useSession } from 'next-auth/react';
import { MessageSquareWarning, Star, X, Camera, Paperclip } from 'lucide-react';
import { useT } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { PendingAttachmentList } from '@/components/MessageThread';
import { installFeedbackCollector, snapshotFeedbackContext } from '@/lib/feedbackCollector';
import { captureViewport, FEEDBACK_UI_ATTR } from '@/lib/feedbackScreenshot';
import { FEEDBACK_DESCRIPTION_MAX } from '@/lib/feedbackContext';
import {
  SUPPORT_ATTACHMENT_ACCEPT,
  appendSupportAttachments,
  type PendingSupportAttachment,
} from '@/lib/supportAttachments';

// The floating "Report a problem" button (#3130), on every signed-in screen.
// Opening it takes the screenshot first — before the panel renders, so the
// panel is never in the picture — which makes a report two clicks plus the
// two required answers: open, describe, choose contact, Send. Nothing leaves
// the tab before Send (docs/feedback-reports.md).

type Shot = { blob: Blob; url: string };

export function FeedbackWidget() {
  const { status } = useSession();
  const t = useT();
  const f = t.feedback;
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'BUG' | 'FEEDBACK'>('BUG');
  const [rating, setRating] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [contact, setContact] = useState<'' | 'true' | 'false'>('');
  const [shot, setShot] = useState<Shot | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState(false);
  const [files, setFiles] = useState<PendingSupportAttachment[]>([]);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const ids = useId();

  // On mount, not on `authenticated`: the session resolves a beat after
  // hydration, and an error in that beat is often the one being reported.
  // The buffers stay in memory either way (feedbackCollector.ts).
  useEffect(() => {
    installFeedbackCollector();
  }, []);

  const reset = useCallback(() => {
    setType('BUG');
    setRating(null);
    setDescription('');
    setContact('');
    setError('');
    setCaptureError(false);
    setShot((s) => { if (s) URL.revokeObjectURL(s.url); return null; });
    setFiles((list) => { list.forEach((a) => URL.revokeObjectURL(a.url)); return []; });
  }, []);

  const close = useCallback(() => setOpen(false), []);
  const dialogRef = useModalFocus<HTMLDivElement>(open, close);

  const capture = useCallback(async (hidePanel: boolean) => {
    setCapturing(true);
    setCaptureError(false);
    if (hidePanel) setOpen(false);
    try {
      // Let React remove the panel before the DOM is copied.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const blob = await captureViewport();
      setShot((old) => { if (old) URL.revokeObjectURL(old.url); return { blob, url: URL.createObjectURL(blob) }; });
    } catch {
      setCaptureError(true);
    } finally {
      setCapturing(false);
      setOpen(true);
    }
  }, []);

  const openPanel = () => {
    reset();
    void capture(false);
  };

  const addFiles = async (selected: FileList | File[]) => {
    const { attachments, error: rejected } = await appendSupportAttachments(files, selected, t.support);
    setFiles(attachments);
    setError(rejected);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) { setError(f.descriptionRequired); return; }
    if (!contact) { setError(f.contactRequired); return; }
    setSending(true);
    setError('');
    try {
      const form = new FormData();
      form.append('type', type);
      if (rating) form.append('rating', String(rating));
      form.append('description', description.trim());
      form.append('contactAllowed', contact);
      form.append('url', window.location.href);
      form.append('viewport', `${window.innerWidth}x${window.innerHeight}`);
      form.append('context', JSON.stringify(snapshotFeedbackContext()));
      if (shot) form.append('screenshot', new File([shot.blob], 'screenshot.jpg', { type: 'image/jpeg' }));
      files.forEach(({ file }) => form.append('files', file));
      const res = await fetch('/api/support/reports', { method: 'POST', body: form });
      if (!res.ok) throw new Error(String(res.status));
      setOpen(false);
      reset();
      toast(f.sent, 'success');
    } catch {
      setError(f.sendFailed);
    } finally {
      setSending(false);
    }
  };

  if (status !== 'authenticated') return null;

  return (
    <div {...{ [FEEDBACK_UI_ATTR]: '' }}>
      {!open && (
        <button
          type="button"
          onClick={openPanel}
          disabled={capturing}
          aria-label={f.open}
          title={f.open}
          data-testid="feedback-open"
          className="fixed right-4 bottom-[calc(1rem+var(--fixed-bottom-inset,0px))] z-[150] flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 disabled:opacity-60 print:hidden"
        >
          <MessageSquareWarning className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-[190] flex justify-end bg-black/30" onClick={close}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${ids}-title`}
            data-testid="feedback-panel"
            onClick={(e) => e.stopPropagation()}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files);
              if (pasted.length) { e.preventDefault(); void addFiles(pasted); }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files); }}
            className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-white p-5 pb-[calc(2rem+env(safe-area-inset-bottom,0px))] shadow-xl dark:bg-gray-900"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <h2 id={`${ids}-title`} className="text-lg font-semibold text-gray-900 dark:text-gray-100">{f.title}</h2>
              <button type="button" onClick={close} aria-label={f.close} className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">{f.intro}</p>

            <form onSubmit={submit} className="space-y-4" noValidate>
              <fieldset>
                <legend className="mb-1 text-sm font-medium text-gray-800 dark:text-gray-200">{f.typeLabel}</legend>
                <div className="flex flex-wrap gap-3 text-sm">
                  {(['BUG', 'FEEDBACK'] as const).map((v) => (
                    <label key={v} className="flex items-center gap-1.5 text-gray-800 dark:text-gray-200">
                      <input type="radio" name="feedback-type" value={v} checked={type === v} onChange={() => setType(v)} />
                      {v === 'BUG' ? f.typeBug : f.typeFeedback}
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-1 text-sm font-medium text-gray-800 dark:text-gray-200">{f.ratingLabel}</legend>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={rating === n}
                      aria-label={f.ratingStar.replace('{n}', String(n))}
                      onClick={() => setRating(rating === n ? null : n)}
                      className="rounded p-0.5 text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-gray-800"
                    >
                      <Star className={`h-6 w-6 ${rating && n <= rating ? 'fill-current' : ''}`} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </fieldset>

              <div>
                <label htmlFor={`${ids}-desc`} className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">{f.descriptionLabel}</label>
                <textarea
                  id={`${ids}-desc`}
                  data-testid="feedback-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={FEEDBACK_DESCRIPTION_MAX}
                  rows={5}
                  required
                  placeholder={f.descriptionPlaceholder}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                />
              </div>

              <div>
                <p className="mb-1 text-sm font-medium text-gray-800 dark:text-gray-200">{f.screenshotLabel}</p>
                {shot ? (
                  <div className="relative inline-block">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL */}
                    <img src={shot.url} alt={f.screenshotAlt} data-testid="feedback-screenshot" className="max-h-40 rounded border border-gray-200 dark:border-gray-700" />
                    <button
                      type="button"
                      onClick={() => setShot((s) => { if (s) URL.revokeObjectURL(s.url); return null; })}
                      aria-label={f.removeScreenshot}
                      className="absolute -right-2 -top-2 rounded-full bg-gray-800 p-1 text-white"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ) : captureError ? (
                  <p className="text-sm text-amber-800 dark:text-amber-300">{f.captureFailed}</p>
                ) : null}
                <div className="mt-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void capture(true)} disabled={capturing} data-testid="feedback-capture">
                    <Camera className="mr-1 h-4 w-4" aria-hidden="true" />
                    {capturing ? f.capturing : shot ? f.recapture : f.capture}
                  </Button>
                </div>
              </div>

              <div>
                <input
                  id={`${ids}-files`}
                  type="file"
                  multiple
                  accept={SUPPORT_ATTACHMENT_ACCEPT}
                  className="sr-only"
                  data-testid="feedback-files"
                  onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
                />
                <label htmlFor={`${ids}-files`} className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-blue-700 hover:underline dark:text-blue-400">
                  <Paperclip className="h-4 w-4" aria-hidden="true" /> {f.attachLabel}
                </label>
                <PendingAttachmentList
                  attachments={files}
                  removeLabel={t.support.removeAttachment}
                  onRemove={(i) => setFiles((list) => {
                    const next = [...list];
                    const [gone] = next.splice(i, 1);
                    if (gone) URL.revokeObjectURL(gone.url);
                    return next;
                  })}
                />
              </div>

              <fieldset>
                <legend className="mb-1 text-sm font-medium text-gray-800 dark:text-gray-200">{f.contactLabel}</legend>
                <div className="flex flex-wrap gap-3 text-sm">
                  {(['true', 'false'] as const).map((v) => (
                    <label key={v} className="flex items-center gap-1.5 text-gray-800 dark:text-gray-200">
                      <input type="radio" name="feedback-contact" value={v} checked={contact === v} onChange={() => setContact(v)} data-testid={`feedback-contact-${v}`} />
                      {v === 'true' ? f.contactYes : f.contactNo}
                    </label>
                  ))}
                </div>
              </fieldset>

              <p className="text-xs text-gray-600 dark:text-gray-400">{f.privacy}</p>
              {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}

              <Button type="submit" disabled={sending || capturing} className="w-full" data-testid="feedback-send">
                {sending ? f.sending : f.send}
              </Button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
