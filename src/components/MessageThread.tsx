'use client';

import type { ReactNode, RefObject } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export interface PendingMessageAttachment {
  file: File;
  url: string;
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

export function PendingAttachmentList({ attachments, onRemove, removeLabel }: {
  attachments: PendingMessageAttachment[];
  onRemove: (index: number) => void;
  removeLabel: string;
}) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap items-start gap-2 mb-2">
      {attachments.map((attachment, index) => (
        <div key={attachment.url} className="relative group">
          {attachment.file.type.startsWith('image/') ? (
            <a href={attachment.url} target="_blank" rel="noopener noreferrer" title={attachment.file.name}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={attachment.url} alt={attachment.file.name} className="h-16 w-16 object-cover rounded-lg border border-gray-200" />
            </a>
          ) : (
            <div className="flex items-center gap-2 text-xs bg-gray-100 dark:bg-gray-800 rounded-lg px-2.5 py-1.5 h-16">
              <FileText className="h-3.5 w-3.5 text-gray-500" />
              <span className="text-gray-700 dark:text-gray-200 max-w-[8rem] truncate">{attachment.file.name}</span>
            </div>
          )}
          <button type="button" onClick={() => onRemove(index)} aria-label={`${removeLabel}: ${attachment.file.name}`} className="absolute -top-1.5 -right-1.5 bg-white rounded-full border border-gray-200 text-gray-400 hover:text-red-600 shadow-sm">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function MessageComposer({
  body, onBodyChange, onSubmit, sending, hasAttachments, placeholder, sendLabel,
  attachLabel, fileInputRef, accept, onFilesSelected, onPaste, onKeyDown,
  inputTestId, attachTestId, sendTestId, textareaTestId,
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
      <textarea value={body} onChange={(event) => onBodyChange(event.target.value)} onPaste={onPaste} onKeyDown={onKeyDown} rows={2} maxLength={5000} placeholder={placeholder} data-testid={textareaTestId} className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 resize-none" />
      <Button type="submit" loading={sending} disabled={empty} data-testid={sendTestId}>{sendLabel}</Button>
    </form>
  );
}
