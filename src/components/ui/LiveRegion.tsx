'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';

export type Politeness = 'polite' | 'assertive';
export type AnnounceFn = (message: string, politeness?: Politeness) => void;

/**
 * WCAG 4.1.3 (Status Messages) — the one live region for the whole app.
 *
 * The rule that makes this a *provider* rather than a component call sites drop
 * in themselves: a live region is only announced when its container was already
 * in the accessibility tree before the text arrived. Rendering
 * `{saved && <p role="status">…</p>}` mounts the container together with its
 * text, and most screen readers stay silent. So the two containers below are
 * mounted once, empty, for the lifetime of the page, and `announce()` only ever
 * changes their text.
 *
 * Visible messages that already sit in a persistent container (Toast,
 * AsyncSection's error branch, CalendarView's loading overlay, the account
 * settings banner) keep their own `role="status"` / `role="alert"` — announcing
 * them here as well would speak them twice. This hook is for state changes that
 * have no visible home of their own, or whose visible home is a chip too terse
 * to be understood out of context.
 */
const AnnouncerContext = createContext<AnnounceFn | null>(null);

const NOOP: AnnounceFn = () => {};

/**
 * `announce(message)` — polite by default. Safe to call outside the provider
 * (returns a no-op) so a component using it never has to care whether it is
 * rendered inside the app shell or in isolation.
 */
export function useAnnounce(): AnnounceFn {
  return useContext(AnnouncerContext) ?? NOOP;
}

export function LiveRegionProvider({ children }: { children: React.ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const seq = useRef(0);

  const announce = useCallback<AnnounceFn>((message, politeness = 'polite') => {
    if (!message) return;
    // A screen reader speaks a live region when its content *changes*. Setting
    // the same string twice ("Saved" after two saves) is not a change, so the
    // second one would be silent. Alternating a trailing no-break space keeps
    // the sentence identical to a listener and different to the DOM.
    seq.current += 1;
    const text = seq.current % 2 === 0 ? `${message} ` : message;
    if (politeness === 'assertive') setAssertive(text);
    else setPolite(text);
  }, []);

  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      {/* aria-atomic: these regions are replaced wholesale, so the reader should
          speak the new sentence rather than diffing it against the old one. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="live-region-polite"
      >
        {polite}
      </p>
      <p
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
        data-testid="live-region-assertive"
      >
        {assertive}
      </p>
    </AnnouncerContext.Provider>
  );
}
