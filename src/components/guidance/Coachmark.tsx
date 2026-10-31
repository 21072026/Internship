'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '@/components/ui/useModalFocus';
import type { TourPlacement } from '@/lib/tours';

// One step of a tour (#2067): a dialog bubble anchored next to the element
// whose `data-tour-id` is `targetId`, a ring around that element and a scrim
// over the rest. Accessibility is the contract, not a nicety:
//   * role="dialog" + aria-modal, labelled by the step title and described by
//     its body; focus moves into it (onto the primary button) and the trap,
//     Escape and focus return come from the same useModalFocus() the app's
//     other dialogs use — Escape SKIPS the tour.
//   * every control is a real button, so the whole tour is keyboard-complete.
//   * no animation at all unless the person allows motion (`motion-safe:`).
// The scrim is decorative (aria-hidden) and swallows clicks: a tour step is a
// modal moment, ended by its own buttons or Escape.

export interface CoachmarkLabels {
  next: string;
  back: string;
  skip: string;
  done: string;
  progress: string;
}

const GAP = 12;
const WIDTH = 320;
const MARGIN = 16;

export function targetElement(targetId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-tour-id]'))) {
    if (el.dataset.tourId === targetId && isShown(el)) return el;
  }
  return null;
}

/** On screen and not tucked away (a closed drawer, an inert or hidden subtree). */
export function isShown(el: HTMLElement): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
}

function bubblePosition(rect: DOMRect, placement: TourPlacement, height: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left: number;
  let top: number;
  if (placement === 'right' && rect.right + GAP + WIDTH <= vw - MARGIN) {
    left = rect.right + GAP;
    top = rect.top;
  } else if (placement === 'left' && rect.left - GAP - WIDTH >= MARGIN) {
    left = rect.left - GAP - WIDTH;
    top = rect.top;
  } else if (placement === 'top' && rect.top - GAP - height >= MARGIN) {
    left = rect.left;
    top = rect.top - GAP - height;
  } else {
    left = rect.left;
    top = rect.bottom + GAP;
  }
  return {
    left: Math.max(MARGIN, Math.min(left, vw - WIDTH - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, vh - height - MARGIN)),
  };
}

export function Coachmark({
  targetId,
  placement,
  title,
  body,
  index,
  total,
  labels,
  onNext,
  onBack,
  onSkip,
}: {
  targetId: string;
  placement: TourPlacement;
  title: string;
  body: string;
  index: number;
  total: number;
  labels: CoachmarkLabels;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(true, onSkip);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const isLast = index === total - 1;

  // Measure the target now and whenever the page moves under it.
  useLayoutEffect(() => {
    const el = targetElement(targetId);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const measure = () => setRect(el.getBoundingClientRect());
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [targetId]);

  useLayoutEffect(() => {
    if (!rect) return;
    setPos(bubblePosition(rect, placement, dialogRef.current?.offsetHeight ?? 180));
  }, [rect, placement, dialogRef]);

  // Each step lands on its primary button. useModalFocus focuses the first
  // control once, on open — while the bubble is still `visibility: hidden`
  // waiting for its position, when nothing in it can take focus — so focus
  // is placed again once it is shown, and on every new step.
  const shown = pos !== null;
  useEffect(() => {
    if (shown) nextRef.current?.focus();
  }, [index, shown]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div aria-hidden="true" className="fixed inset-0 z-[210] bg-black/40" data-testid="tour-scrim" />
      {rect && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[211] rounded-lg ring-4 ring-blue-400 motion-safe:transition-all"
          style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      )}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
        aria-describedby="tour-step-body"
        tabIndex={-1}
        data-testid="tour-coachmark"
        data-tour-step={index}
        className="fixed z-[212] rounded-lg bg-white p-4 shadow-xl dark:bg-gray-800 motion-safe:transition-[left,top]"
        style={{ width: WIDTH, left: pos?.left ?? MARGIN, top: pos?.top ?? MARGIN, visibility: pos ? 'visible' : 'hidden' }}
      >
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400" data-testid="tour-progress">
          {labels.progress.replace('{n}', String(index + 1)).replace('{total}', String(total))}
        </p>
        <h2 id="tour-step-title" className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h2>
        <p id="tour-step-body" className="mt-1 text-sm text-gray-700 dark:text-gray-300">
          {body}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onSkip}
            data-testid="tour-skip"
            className="mr-auto rounded px-2 py-1 text-sm text-gray-600 underline-offset-2 hover:underline dark:text-gray-300"
          >
            {labels.skip}
          </button>
          {index > 0 && (
            <button
              type="button"
              onClick={onBack}
              data-testid="tour-back"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-800 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              {labels.back}
            </button>
          )}
          <button
            ref={nextRef}
            type="button"
            onClick={onNext}
            data-testid="tour-next"
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            {isLast ? labels.done : labels.next}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
