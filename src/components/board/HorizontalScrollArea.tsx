'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { dragAutoScrollStep } from '@/lib/dragAutoScrollRule';

// No dragover for this long = the drag left the scroller (or ended without a
// drop reaching us). Browsers repeat dragover every ~50ms even while the
// pointer stands still, so this never stops a drag that is still here.
const DRAG_IDLE_MS = 150;

export function HorizontalScrollArea({
  children,
  className = '',
  testId,
  label,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
  /**
   * Accessible name for the scroller. Supplying it turns the scrolling box into
   * a named `region` a keyboard can reach — see the `tabIndex` note below.
   */
  label?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const update = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setCanScrollLeft(element.scrollLeft > 1);
    setCanScrollRight(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
  }, []);

  useLayoutEffect(update);

  // Auto-scroll while a card is dragged near an edge (#3662): the browser's
  // native drag-and-drop does not scroll an inner horizontal box, so a stage
  // off-screen could not be reached. dragover only records the step; one
  // animation-frame loop applies it, and stops once dragover stops arriving.
  // Touch never starts an HTML5 drag, so phones are unaffected.
  const dragStep = useRef(0);
  const lastDragOver = useRef(0);
  const frame = useRef<number | null>(null);
  const stopDragScroll = useCallback(() => {
    dragStep.current = 0;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const runDragScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element || dragStep.current === 0 || performance.now() - lastDragOver.current > DRAG_IDLE_MS) {
      stopDragScroll();
      return;
    }
    element.scrollLeft += dragStep.current;
    frame.current = requestAnimationFrame(runDragScroll);
  }, [stopDragScroll]);
  // Capture phase: a column's own dragover handler must not be able to hide
  // the pointer from us.
  const onDragOverCapture = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const element = scrollRef.current;
      if (!element) return;
      const box = element.getBoundingClientRect();
      lastDragOver.current = performance.now();
      dragStep.current = dragAutoScrollStep(
        event.clientX,
        Math.max(box.left, 0),
        Math.min(box.right, window.innerWidth),
      );
      if (dragStep.current !== 0 && frame.current === null) frame.current = requestAnimationFrame(runDragScroll);
    },
    [runDragScroll],
  );
  useEffect(() => stopDragScroll, [stopDragScroll]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const resizeObserver = new ResizeObserver(update);
    const mutationObserver = new MutationObserver(update);
    resizeObserver.observe(element);
    mutationObserver.observe(element, { childList: true, subtree: true });
    window.addEventListener('resize', update);
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [update]);

  // A box that scrolls but cannot take focus is unreachable with a keyboard
  // whenever it holds nothing focusable — on the board that is an empty stage
  // column, whose content a keyboard-only user simply cannot bring into view
  // (axe calls this `scrollable-region-focusable`). Focusable *only while it can
  // actually scroll*, so a board whose columns already fit does not grow a dead
  // tab stop; and named, because an unnamed `region` is worse than none.
  const scrollable = canScrollLeft || canScrollRight;

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        data-testid={testId}
        onScroll={update}
        onDragOverCapture={onDragOverCapture}
        onDropCapture={stopDragScroll}
        {...(scrollable ? { tabIndex: 0 } : {})}
        {...(scrollable && label ? { role: 'region', 'aria-label': label } : {})}
        className={`overflow-x-auto ${className}`}
      >
        {children}
      </div>
      {canScrollLeft && (
        <div
          aria-hidden="true"
          data-testid={testId ? `${testId}-left-hint` : undefined}
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-white/95 via-white/60 to-transparent dark:from-gray-950/90 dark:via-gray-950/50"
        />
      )}
      {canScrollRight && (
        <div
          aria-hidden="true"
          data-testid={testId ? `${testId}-right-hint` : undefined}
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-white/95 via-white/60 to-transparent dark:from-gray-950/90 dark:via-gray-950/50"
        />
      )}
    </div>
  );
}
