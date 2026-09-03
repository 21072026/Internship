'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useT } from '@/i18n/client';
import { useModalFocus } from './useModalFocus';

export interface LightboxImage {
  /** What the <img> loads — the full-size source, not the thumbnail. */
  src: string;
  /** Shown in the title bar and used as the download filename. */
  filename?: string;
  alt?: string;
}

const ZOOM_STEPS = [1, 1.5, 2, 3] as const;

export interface ImageLightboxProps {
  images: LightboxImage[];
  /** Index of the visible image; `null` means closed. */
  index: number | null;
  onClose: () => void;
  onIndexChange?: (index: number) => void;
}

/**
 * Full-screen image viewer with a way *out* on every input a person might
 * reach for: the ✕ button, Escape, a tap on the backdrop and — the one that
 * prompted this (#2147) — the phone's own back gesture.
 *
 * Opening a full-size image in a new tab (`target="_blank"`) looked equivalent
 * and was not: inside the installed PWA / an in-app browser that tab has no
 * chrome, so the enlarged image became a dead end and the only way back was
 * killing the app.
 */
export function ImageLightbox({ images, index, onClose, onIndexChange }: ImageLightboxProps) {
  const t = useT();
  const open = index !== null && index >= 0 && index < images.length;
  const dialogRef = useModalFocus<HTMLDivElement>(open, onClose);
  const [zoomStep, setZoomStep] = useState(0);
  const [mounted, setMounted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => setMounted(true), []);

  const current = open ? images[index] : null;
  const count = images.length;
  const go = useCallback(
    (delta: number) => {
      if (index === null || count < 2 || !onIndexChange) return;
      onIndexChange((index + delta + count) % count);
    },
    [index, count, onIndexChange]
  );

  // A new image always starts fitted — inheriting the previous one's zoom is
  // disorienting, and on a portrait photo it lands you mid-image.
  useEffect(() => setZoomStep(0), [index]);

  // Zooming enlarges around the middle: an overflowing image otherwise sits at
  // the scroll origin, so pressing + on a wide screenshot jumps to its left
  // edge instead of magnifying what the reader was looking at.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, [zoomStep]);

  // The page behind must not scroll while the viewer covers it.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Android's back button / the iOS back swipe should close the viewer, not
  // leave the page. A history entry is pushed while it is open and popped
  // again when it closes by any other route, so the back stack stays balanced.
  useEffect(() => {
    if (!open) return;
    let closedByBack = false;
    window.history.pushState({ imageLightbox: true }, '', window.location.href);
    const onPopState = () => {
      closedByBack = true;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (!closedByBack && (window.history.state as { imageLightbox?: boolean } | null)?.imageLightbox) {
        window.history.back();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') go(1);
      else if (event.key === 'ArrowLeft') go(-1);
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, go]);

  if (!mounted || !open || !current) return null;

  const zoom = ZOOM_STEPS[zoomStep];
  const label = current.filename ?? current.alt ?? '';
  const buttonClass =
    'inline-flex h-11 w-11 items-center justify-center rounded-full text-white/90 hover:bg-white/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40 disabled:hover:bg-transparent';

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t.imageViewer.title}
      data-testid="image-lightbox"
      tabIndex={-1}
      className="fixed inset-0 z-[300] flex flex-col bg-black/95 backdrop-blur-md"
    >
      <div className="flex items-center gap-1 p-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:gap-2">
        <p className="min-w-0 flex-1 truncate px-2 text-sm text-white/80" title={label}>
          {label}
        </p>
        <button
          type="button"
          className={buttonClass}
          onClick={() => setZoomStep((s) => Math.max(0, s - 1))}
          disabled={zoomStep === 0}
          aria-label={t.imageViewer.zoomOut}
          data-testid="image-lightbox-zoom-out"
        >
          <ZoomOut className="h-5 w-5" aria-hidden />
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => setZoomStep((s) => Math.min(ZOOM_STEPS.length - 1, s + 1))}
          disabled={zoomStep === ZOOM_STEPS.length - 1}
          aria-label={t.imageViewer.zoomIn}
          data-testid="image-lightbox-zoom-in"
        >
          <ZoomIn className="h-5 w-5" aria-hidden />
        </button>
        <a
          href={current.src}
          download={current.filename || ""}
          className={buttonClass}
          aria-label={t.imageViewer.download}
          data-testid="image-lightbox-download"
          onClick={(e) => e.stopPropagation()}
        >
          <Download className="h-5 w-5" aria-hidden />
        </a>
        <button
          type="button"
          className={buttonClass}
          onClick={onClose}
          aria-label={t.imageViewer.close}
          data-testid="image-lightbox-close"
        >
          <X className="h-6 w-6" aria-hidden />
        </button>
      </div>

      {/* Tapping the surround closes; tapping the image itself zooms, so a
          mis-aimed tap never dismisses the thing you were trying to enlarge. */}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 touch-pinch-zoom overflow-auto p-2"
        onClick={onClose}
        data-testid="image-lightbox-backdrop"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current.src}
          alt={current.alt ?? current.filename ?? ''}
          data-testid="image-lightbox-image"
          onClick={(e) => {
            e.stopPropagation();
            setZoomStep((s) => (s === 0 ? 1 : 0));
          }}
          className={`m-auto ${zoom === 1 ? 'max-h-full max-w-full object-contain' : 'cursor-zoom-out'}`}
          style={zoom === 1 ? undefined : { width: `${zoom * 100}%`, maxWidth: 'none' }}
        />
      </div>

      {count > 1 && (
        <div className="flex items-center justify-center gap-4 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-sm text-white/80">
          <button
            type="button"
            className={buttonClass}
            onClick={() => go(-1)}
            aria-label={t.imageViewer.previous}
            data-testid="image-lightbox-prev"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
          <span data-testid="image-lightbox-counter">
            {t.imageViewer.counter.replace('{i}', String(index + 1)).replace('{n}', String(count))}
          </span>
          <button
            type="button"
            className={buttonClass}
            onClick={() => go(1)}
            aria-label={t.imageViewer.next}
            data-testid="image-lightbox-next"
          >
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
        </div>
      )}
    </div>,
    document.body
  );
}

/**
 * State for a single lightbox per screen: `open(images, index)` from a
 * thumbnail's click handler, spread `lightboxProps` onto one `<ImageLightbox>`.
 */
export function useImageLightbox() {
  const [state, setState] = useState<{ images: LightboxImage[]; index: number } | null>(null);

  const open = useCallback((images: LightboxImage[], index = 0) => setState({ images, index }), []);
  const close = useCallback(() => setState(null), []);
  const setIndex = useCallback(
    (index: number) => setState((s) => (s ? { ...s, index } : s)),
    []
  );

  return {
    open,
    close,
    lightboxProps: {
      images: state?.images ?? [],
      index: state?.index ?? null,
      onClose: close,
      onIndexChange: setIndex,
    } satisfies ImageLightboxProps,
  };
}
