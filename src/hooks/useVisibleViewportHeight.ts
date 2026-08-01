'use client';

import { useEffect } from 'react';

const CSS_VAR = '--visible-viewport-height';

/**
 * Publishes the height that is actually *visible* as `--visible-viewport-height`
 * on `<html>`, for full-height screens to clamp themselves with (#1009).
 *
 * `100dvh` is the layout viewport, and that is not always what you can see: an
 * installed PWA on Android draws behind the system navigation bar, so the bottom
 * ~48px of `100dvh` sit under it — and because the document then has no overflow
 * either, that strip cannot be scrolled into view. The frame subtracts
 * `env(safe-area-inset-bottom)` for exactly this, but the visual viewport is a
 * second, independent signal: whichever of the two is more conservative wins,
 * because the frame *clamps* with `max-height` instead of adding another
 * subtraction (two identical corrections would leave a gap instead of closing one).
 *
 * Also tracks the on-screen keyboard: with `interactive-widget=resizes-content`
 * both signals shrink, so the composer stays above it. Pinch-zoom is ignored —
 * a zoomed visual viewport is smaller without anything being hidden.
 */
export function useVisibleViewportHeight(active = true) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const apply = () => {
      const vv = window.visualViewport;
      const zoomed = vv ? vv.scale > 1.01 : false;
      const height = vv && !zoomed ? Math.min(window.innerHeight, vv.height) : window.innerHeight;
      root.style.setProperty(CSS_VAR, `${Math.round(height)}px`);
    };
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      window.visualViewport?.removeEventListener('resize', apply);
      window.visualViewport?.removeEventListener('scroll', apply);
      root.style.removeProperty(CSS_VAR);
    };
  }, [active]);
}
