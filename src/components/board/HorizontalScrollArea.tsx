'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function HorizontalScrollArea({
  children,
  className = '',
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
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

  return (
    <div className="relative">
      {/* tabIndex makes the scroller itself reachable by keyboard. Without it a
          mouse-less user cannot pan the board at all — the columns past the
          fold are simply unreachable — which is what axe reports as
          `scrollable-region-focusable` (serious). Deliberately no `role` to go
          with it: an unnamed `role="region"` would only trade this violation
          for a `region`-name one. */}
      <div ref={scrollRef} tabIndex={0} data-testid={testId} onScroll={update} className={`overflow-x-auto ${className}`}>
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
