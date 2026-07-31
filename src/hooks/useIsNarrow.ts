'use client';

import { useEffect, useState } from 'react';

/**
 * True when the viewport is narrower than Tailwind's `lg` breakpoint.
 *
 * For layouts that must render *either* the mobile or the desktop variant, never
 * both: rendering both and hiding one with `lg:hidden` would put every card in
 * the DOM twice, which breaks Playwright's strict mode (two matches per mentee)
 * and doubles the work for screen readers.
 *
 * Starts `false` so the first client render matches the server-rendered markup;
 * the switch happens in an effect, so there is no hydration mismatch.
 */
export function useIsNarrow(query = '(max-width: 1023px)') {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [query]);

  return narrow;
}
