'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Publishes the height of the app-wide banner strip that sits at the very top of
 * the document as `--top-banner-inset` on `<html>` (0px when nothing is showing).
 *
 * The strip is in normal flow, so ordinary pages simply start below it. Screens
 * that size themselves against the viewport (`100dvh` — the chat frame, #1006)
 * cannot see it that way and would overflow the viewport by exactly the banner's
 * height, so they subtract this variable instead.
 *
 * Mirror of `useFixedBottomInset` at the other edge; re-measured with a
 * ResizeObserver because the banner reflows when its text wraps (locale, rotation).
 */
const CSS_VAR = '--top-banner-inset';

export function useTopBannerInset(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;

    const root = document.documentElement;
    const measure = () => {
      root.style.setProperty(CSS_VAR, `${Math.ceil(el.getBoundingClientRect().height)}px`);
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.setProperty(CSS_VAR, '0px');
    };
  }, [ref, active]);
}
