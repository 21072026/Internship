import { Download, FileText } from 'lucide-react';
import type { SupportAttachmentMeta } from '@/lib/supportAttachments';

export function SupportAttachmentList({ attachments }: { attachments: SupportAttachmentMeta[] }) {
  if (!attachments.length) return null;

  return (
    <div className="mt-2 grid gap-2">
      {attachments.map((attachment) => {
        const url = `/api/support/attachments/${attachment.id}`;
        const image = attachment.contentType.startsWith('image/');
        return (
          <a
            key={attachment.id}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="block overflow-hidden rounded-lg border border-black/10 bg-white/10 hover:ring-2 hover:ring-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            {image && (
              // The authenticated attachment route cannot be used with Next Image optimization.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt={attachment.filename} className="max-h-48 w-full object-contain bg-black/5" />
            )}
            <span className="flex items-center gap-2 px-2 py-1.5 text-xs">
              {image ? <Download className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
              <span className="shrink-0 opacity-70">{Math.max(1, Math.round(attachment.size / 1024))} KB</span>
            </span>
          </a>
        );
      })}
    </div>
  );
}
