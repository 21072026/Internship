'use client';

import { Download, FileText } from 'lucide-react';
import type { SupportAttachmentMeta } from '@/lib/supportAttachments';
import { useT } from '@/i18n/client';
import { ImageLightbox, useImageLightbox } from '@/components/ui/ImageLightbox';

export function SupportAttachmentList({ attachments }: { attachments: SupportAttachmentMeta[] }) {
  const t = useT();
  const lightbox = useImageLightbox();

  if (!attachments.length) return null;

  const urlFor = (id: string) => `/api/support/attachments/${id}`;
  const images = attachments
    .filter((a) => a.contentType.startsWith('image/'))
    .map((a) => ({ src: urlFor(a.id), filename: a.filename }));

  return (
    <div className="mt-2 grid gap-2">
      {attachments.map((attachment) => {
        const url = urlFor(attachment.id);
        const image = attachment.contentType.startsWith('image/');
        const meta = (
          <span className="flex items-center gap-2 px-2 py-1.5 text-xs">
            {image ? <Download className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
            <span className="shrink-0 opacity-70">{Math.max(1, Math.round(attachment.size / 1024))} KB</span>
          </span>
        );
        const frameClass =
          'block w-full overflow-hidden rounded-lg border border-black/10 bg-white/10 text-left hover:ring-2 hover:ring-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400';

        // An image opens in the in-app viewer (which can be closed); anything
        // else still hands off to the browser, where a PDF or a .docx belongs.
        return image ? (
          <button
            key={attachment.id}
            type="button"
            aria-label={t.imageViewer.view.replace('{name}', attachment.filename)}
            data-testid="support-image-attachment"
            onClick={() => lightbox.open(images, images.findIndex((i) => i.src === url))}
            className={frameClass}
          >
            {/* The authenticated attachment route cannot be used with Next Image optimization. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={attachment.filename} className="max-h-48 w-full object-contain bg-black/5" />
            {meta}
          </button>
        ) : (
          <a key={attachment.id} href={url} target="_blank" rel="noopener noreferrer" className={frameClass}>
            {meta}
          </a>
        );
      })}
      <ImageLightbox {...lightbox.lightboxProps} />
    </div>
  );
}
