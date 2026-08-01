'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Keeps page content clear of fixed bottom bars (cookie banner today, mobile
 * quick-action bars later).
 *
 * A bar pinned with `fixed bottom-0` paints over whatever is underneath it, so
 * on a phone — where a banner can eat 40% of the viewport — the primary button
 * at the end of a page becomes unreachable (#935). Fix: every fixed bottom bar
 * publishes its measured height here, and the tallest one is written to the
 * `--fixed-bottom-inset` custom property on <html>. `globals.css` turns that
 * into `body { padding-bottom }`, so the document simply grows and the content
 * can always be scrolled above the bar. The inset returns to 0px as soon as the
 * bar unmounts, leaving no leftover gap.
 *
 * The height is re-measured with a ResizeObserver: banners reflow when the text
 * wraps differently (locale, rotation, "customize" panel opening).
 */
const CSS_VAR = '--fixed-bottom-inset';

const bars = new Map<number, number>();
let nextId = 0;

function publish() {
  const tallest = bars.size ? Math.max(...bars.values()) : 0;
  document.documentElement.style.setProperty(CSS_VAR, `${Math.ceil(tallest)}px`);
}

export function useFixedBottomInset(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;

    const id = nextId++;
    const measure = () => {
      bars.set(id, el.getBoundingClientRect().height);
      publish();
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      bars.delete(id);
      publish();
    };
  }, [ref, active]);
}
