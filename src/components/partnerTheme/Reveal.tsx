'use client';

import { useEffect, useRef } from 'react';
import type { ThemeOptions } from '@/lib/affiliateLandingRule';

// A section of a themed partner page that animates in when it scrolls into view
// (#3535). The server renders it visible; only after hydration — and only when
// the visitor's device does NOT ask for reduced motion — is it "armed" (hidden
// until seen). The CSS in globals.css (`.pt-reveal`) repeats the reduced-motion
// condition, so a preference changed mid-visit wins too, and without script the
// content is simply there.
export function Reveal({ animation, children, className }: { animation: ThemeOptions['animation']; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || animation === 'none' || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.dataset.armed = '';
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.dataset.shown = '';
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [animation]);
  if (animation === 'none') return <div className={className}>{children}</div>;
  return (
    <div ref={ref} className={`pt-reveal ${className ?? ''}`} data-anim={animation}>
      {children}
    </div>
  );
}
