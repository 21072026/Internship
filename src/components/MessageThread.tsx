'use client';

import type { ReactNode, RefObject } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { useT } from '@/i18n/client';
import { ImageLightbox, useImageLightbox } from '@/components/ui/ImageLightbox';

export interface PendingMessageAttachment {
  file: File;
  url: string;
  /** What an image shows, in the sender's words — sent as its alt text (#2864). */
  alt?: string;
}

export function MessageBubble({ mine, senderLabel, children }: {
  mine: boolean;
  senderLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
        mine ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100'
      }`}>
        {!mine && senderLabel && <p className="text-xs font-medium mb-0.5 opacity-70">{senderLabel}</p>}
        {children}
      </div>
    </div>
  );
}

export function PendingAttachmentList({ attachments, onRemove, removeLabel, onAltChange }: {
  attachments: PendingMessageAttachment[];
  onRemove: (index: number) => void;
  removeLabel: string;
  /**
   * When given, every image gets a "Describe this image" field — the authoring
   * prompt of EN 301 549 11.8.2 / Section 508 504.3 (#2864). Only the composers
   * that store the text pass it.
   */
  onAltChange?: (index: number, alt: string) => void;
}) {
  const t = useT();
  const lightbox = useImageLightbox();
  const images = attachments
    .filter((a) => a.file.type.startsWith('image/'))
    .map((a) => ({ src: a.url, filename: a.file.name }));

  if (!attachments.length) return null;
  return (
    <div data-testid="pending-attachments" className="flex flex-wrap items-start gap-2 mb-2">
      {attachments.map((attachment, index) => (
        <div key={attachment.url} className="relative group">
          {attachment.file.type.startsWith('image/') ? (
            <button
              type="button"
              title={attachment.file.name}
              aria-label={t.imageViewer.view.replace('{name}', attachment.file.name)}
              data-testid="pending-image-attachment"
              onClick={() => lightbox.open(images, images.findIndex((i) => i.src === attachment.url))}
              className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={attachment.url} alt={attachment.file.name} className="h-16 w-16 object-cover rounded-lg border border-gray-200" />
            </button>
          ) : (
            <div className="flex items-center gap-2 text-xs bg-gray-100 dark:bg-gray-800 rounded-lg px-2.5 py-1.5 h-16">
              <FileText className="h-3.5 w-3.5 text-gray-500" />
              <span className="text-gray-700 dark:text-gray-200 max-w-[8rem] truncate">{attachment.file.name}</span>
            </div>
          )}
          <button type="button" onClick={() => onRemove(index)} aria-label={`${removeLabel}: ${attachment.file.name}`} data-testid="pending-attachment-remove" className="absolute -top-1.5 -right-1.5 bg-white rounded-full border border-gray-200 text-gray-400 hover:text-red-600 shadow-sm">
            <X className="h-3.5 w-3.5" />
          </button>
          {onAltChange && attachment.file.type.startsWith('image/') && (
            <label className="mt-1 block w-48 text-xs text-gray-600 dark:text-gray-300">
              {t.imageViewer.altLabel}
              <input
                type="text"
                value={attachment.alt ?? ''}
                maxLength={TEXT_LIMITS.imageAltText}
                onChange={(e) => onAltChange(index, e.target.value)}
                data-testid="pending-attachment-alt"
                className="mt-0.5 block w-full rounded border border-gray-300 bg-white px-1.5 py-1 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
              <span className="mt-0.5 block text-[11px] text-gray-500 dark:text-gray-400">{t.imageViewer.altHint}</span>
            </label>
          )}
        </div>
      ))}
      <ImageLightbox {...lightbox.lightboxProps} />
    </div>
  );
}

export function MessageComposer({
  body, onBodyChange, onSubmit, sending, hasAttachments, placeholder, sendLabel,
  attachLabel, fileInputRef, accept, onFilesSelected, onPaste, onKeyDown,
  inputTestId, attachTestId, sendTestId, textareaTestId, textareaRef,
}: {
  body: string;
  onBodyChange: (body: string) => void;
  onSubmit: () => void;
  sending: boolean;
  hasAttachments: boolean;
  placeholder: string;
  sendLabel: string;
  attachLabel: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  accept: string;
  onFilesSelected: (files: FileList) => void;
  onPaste?: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  inputTestId?: string;
  attachTestId?: string;
  sendTestId?: string;
  textareaTestId?: string;
  /** Lets the caller focus/caret the box — e.g. after filling it from a suggestion. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const empty = !body.trim() && !hasAttachments;
  return (
    <form onSubmit={(event) => { event.preventDefault(); if (!empty) onSubmit(); }} className="flex gap-2">
      <input ref={fileInputRef} type="file" multiple accept={accept} className="hidden" onChange={(event) => {
        if (event.target.files) onFilesSelected(event.target.files);
      }} data-testid={inputTestId} />
      <Button type="button" variant="outline" disabled={sending} onClick={() => fileInputRef.current?.click()} aria-label={attachLabel} title={attachLabel} data-testid={attachTestId}>
        <Paperclip className="h-4 w-4" />
      </Button>
      <Textarea ref={textareaRef} value={body} onChange={(event) => onBodyChange(event.target.value)} onPaste={onPaste} onKeyDown={onKeyDown} rows={2} maxLength={TEXT_LIMITS.messageBody} showCounter placeholder={placeholder} data-testid={textareaTestId} wrapperClassName="flex-1" className="resize-none" />
      <Button type="submit" loading={sending} disabled={empty} data-testid={sendTestId}>{sendLabel}</Button>
    </form>
  );
}
