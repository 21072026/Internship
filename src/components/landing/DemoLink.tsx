'use client';

import type { ReactNode } from 'react';
import { track } from '@/lib/track';
import type { DemoLinkPlacement } from '@/lib/demoMode';

/**
 * An outbound link to the public demo that reports its own click (#1391).
 *
 * The three call sites are server components, so the anchor had nowhere to hang
 * a handler; this is the smallest client boundary that fixes that — a plain
 * `<a>` plus one `onClick`. It renders no chrome of its own and takes the
 * caller's classes, so the buttons look exactly as they did.
 *
 * `href` is passed in rather than derived from `placement` on purpose: keeping
 * `demoUrl()` on the server side means `src/lib/demoMode.ts` — the demo block
 * list, the shared credentials and the server-only `IS_DEMO_MODE` env read —
 * stays out of the landing page's client bundle. Only the *type* is imported
 * here, which erases at compile time. The one rule for callers: `href` must come
 * from `demoUrl(placement)` with the same placement, or the UTM tag and the
 * event will disagree.
 *
 * The event carries the placement and nothing else. This is an anonymous public
 * page and it must stay that way — no user id, no e-mail, no session.
 */
export function DemoLink({
  href,
  placement,
  className,
  children,
  testId,
  target,
  rel,
}: {
  href: string;
  placement: DemoLinkPlacement;
  className?: string;
  children: ReactNode;
  testId?: string;
  target?: '_blank';
  /** Required when `target="_blank"`; always include `noopener`. */
  rel?: string;
}) {
  return (
    <a
      href={href}
      data-testid={testId}
      className={className}
      target={target}
      rel={rel}
      // Fired before the browser starts navigating. See src/lib/track.ts for
      // what survives the unload and why the UTM parameters back it up.
      onClick={() => track('demo_cta_click', { placement })}
    >
      {children}
    </a>
  );
}
