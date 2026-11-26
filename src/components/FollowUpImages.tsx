'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { useT } from '@/i18n/client';
import { ImageLightbox, useImageLightbox } from '@/components/ui/ImageLightbox';
import { FOLLOW_UP_IMAGE_MAX } from '@/lib/followUpImageRule';

// Images on a follow-up, the UI half (#3932; the API and the rules are #3931,
// src/lib/followUpImages.ts and followUpImageRule.ts). A pasted or picked image
// is uploaded at once as a DRAFT; the follow-up write that follows names the
// ids the form holds (`nextActionImageIds`, the hand-off's `imageIds`) and only
// then do they reach the follow-up. A draft the form drops is never attached
// and expires on the server. Shown as thumbnails that open in the app's
// lightbox — never a new tab (#2147).

export interface FollowUpImageItem {
  id: string;
}

export const followUpImageSrc = (id: string) => `/api/follow-up-images/${id}`;

/** The image files on a paste, if any. */
export function pastedImageFiles(e: React.ClipboardEvent): File[] {
  return Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
}

/**
 * The images a follow-up form holds: the ones already on the follow-up (seeded
 * by `reset`) plus drafts uploaded from this form. Uploads go to `relationId`.
 */
export function useFollowUpImageDrafts(relationId: string | null) {
  const t = useT();
  const f = t.followUp;
  const [items, setItems] = useState<FollowUpImageItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const add = useCallback(
    async (files: File[]) => {
      if (!relationId || files.length === 0) return;
      setError('');
      const room = FOLLOW_UP_IMAGE_MAX - itemsRef.current.length;
      if (room <= 0) {
        setError(f.imageTooMany.replace('{max}', String(FOLLOW_UP_IMAGE_MAX)));
        return;
      }
      if (files.length > room) setError(f.imageTooMany.replace('{max}', String(FOLLOW_UP_IMAGE_MAX)));
      setUploading(true);
      try {
        for (const file of files.slice(0, room)) {
          const body = new FormData();
          body.append('file', file);
          const res = await fetch(`/api/mentorship/${relationId}/follow-up-images`, { method: 'POST', body });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const messages: Record<string, string> = {
              not_an_image: f.imageNotImage,
              too_large: f.imageTooLarge,
              too_many_drafts: f.imageTooMany.replace('{max}', String(FOLLOW_UP_IMAGE_MAX)),
            };
            setError(messages[data.code as string] ?? f.imageFailed);
            continue;
          }
          setItems((cur) => [...cur, { id: data.image.id as string }]);
        }
      } catch {
        setError(f.imageFailed);
      } finally {
        setUploading(false);
      }
    },
    [relationId, f],
  );

  const remove = useCallback((id: string) => setItems((cur) => cur.filter((i) => i.id !== id)), []);
  const reset = useCallback((next: FollowUpImageItem[]) => {
    setItems(next);
    setError('');
  }, []);

  return { items, ids: items.map((i) => i.id), add, remove, reset, uploading, error };
}

/** The editor's strip: thumbnails with a remove button, and "Add image". */
export function FollowUpImagePicker({
  drafts,
  testIdPrefix,
  disabled = false,
}: {
  drafts: ReturnType<typeof useFollowUpImageDrafts>;
  testIdPrefix: string;
  disabled?: boolean;
}) {
  const t = useT();
  const f = t.followUp;
  const inputRef = useRef<HTMLInputElement>(null);
  const full = drafts.items.length >= FOLLOW_UP_IMAGE_MAX;
  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-images`}>
      <div className="flex flex-wrap items-center gap-2">
        {drafts.items.map((img, i) => (
          <div key={img.id} className="relative" data-testid={`${testIdPrefix}-image`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={followUpImageSrc(img.id)} alt={f.imageAlt.replace('{n}', String(i + 1))} className="h-16 w-16 rounded border border-gray-200 object-cover dark:border-gray-700" />
            <button
              type="button"
              disabled={disabled}
              onClick={() => drafts.remove(img.id)}
              aria-label={f.imageRemove.replace('{n}', String(i + 1))}
              className="absolute -right-2 -top-2 rounded-full bg-white p-0.5 text-gray-600 shadow hover:text-red-600 dark:bg-gray-800 dark:text-gray-300"
              data-testid={`${testIdPrefix}-image-remove`}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
        {!full && (
          <button
            type="button"
            disabled={disabled || drafts.uploading}
            onClick={() => inputRef.current?.click()}
            className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-dashed border-gray-300 px-3 text-xs text-gray-600 hover:border-blue-400 hover:text-blue-700 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300"
            data-testid={`${testIdPrefix}-image-add`}
          >
            <ImagePlus className="h-4 w-4" aria-hidden="true" />
            {drafts.uploading ? f.imageUploading : f.imageAdd}
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void drafts.add(files);
          }}
          data-testid={`${testIdPrefix}-image-input`}
        />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">{f.imagePasteHint}</p>
      {drafts.error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400" data-testid={`${testIdPrefix}-image-error`}>
          {drafts.error}
        </p>
      )}
    </div>
  );
}

/** Read-only thumbnails that open in the lightbox. Nothing renders without images. */
export function FollowUpImageThumbs({ images, testId, size = 'md' }: { images: FollowUpImageItem[]; testId: string; size?: 'sm' | 'md' }) {
  const t = useT();
  const f = t.followUp;
  const lightbox = useImageLightbox();
  if (images.length === 0) return null;
  const all = images.map((img, i) => ({ src: followUpImageSrc(img.id), alt: f.imageAlt.replace('{n}', String(i + 1)) }));
  const box = size === 'sm' ? 'h-10 w-10' : 'h-16 w-16';
  return (
    <div className="flex flex-wrap gap-2" data-testid={testId}>
      {images.map((img, i) => (
        <button
          key={img.id}
          type="button"
          onClick={() => lightbox.open(all, i)}
          aria-label={f.imageOpen.replace('{n}', String(i + 1))}
          className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          data-testid={`${testId}-item`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={followUpImageSrc(img.id)} alt="" className={`${box} rounded border border-gray-200 object-cover dark:border-gray-700`} />
        </button>
      ))}
      <ImageLightbox {...lightbox.lightboxProps} />
    </div>
  );
}

/** The images on a record's follow-up now, read from the API; `reload` after a save. */
export function useCurrentFollowUpImages(relationId: string, enabled: boolean) {
  const [images, setImages] = useState<FollowUpImageItem[]>([]);
  const reload = useCallback(async () => {
    if (!enabled) return [];
    try {
      const res = await fetch(`/api/mentorship/${relationId}/follow-up-images`);
      if (!res.ok) return [];
      const data = await res.json();
      const next = ((data.current ?? []) as { id: string }[]).map((r) => ({ id: r.id }));
      setImages(next);
      return next;
    } catch {
      return [];
    }
  }, [relationId, enabled]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { images, setImages, reload };
}
