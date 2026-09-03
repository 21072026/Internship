'use client';

import { useEffect } from 'react';
import { readStoredTheme } from '@/lib/theme';

/**
 * Follows a live OS appearance switch while the tab is open, for users whose
 * theme preference is `system` (#2078).
 *
 * App-wide rather than inside ThemeToggle: the toggle is only in the public
 * header, the sidebar account menu and the public profile page — `/account`,
 * where the theme *select* lives, renders none of them, so a listener owned by
 * the toggle would leave "choose system, then change the OS" doing nothing on
 * exactly the page the user just made the choice on.
 *
 * The preference is re-read on each event instead of being held in state, so
 * whichever control wrote it last (toggle or select) is the one this follows.
 * Only the `change` event is handled: the pre-paint script in layout.tsx has
 * already resolved the *current* OS setting, and re-applying it on mount would
 * only risk overruling what the server painted.
 */
export function SystemThemeSync() {
  useEffect(() => {
    const mq = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    if (!mq) return;
    const onChange = () => {
      if (readStoredTheme() !== 'system') return;
      document.documentElement.classList.toggle('dark', mq.matches);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return null;
}
