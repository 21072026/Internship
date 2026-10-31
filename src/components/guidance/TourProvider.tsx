'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useT } from '@/i18n/client';
import { GUIDANCE_AUTOSTART_KEY, firstRunTourFor, tourById, type TourDef, type TourOutcome, type TourStep } from '@/lib/tours';
import { Coachmark, targetElement } from './Coachmark';

// The tour runtime (#2067). Mounted once per role shell; holds the active tour
// and its step. On the first visit of a person who has never finished or
// skipped their role's first-run tour (GET /api/guidance — the server's
// record, so a new laptop does not re-tour anybody) it offers that tour.
// Finishing or skipping writes the outcome back (POST /api/guidance).
// Everything a tour SAYS is the `guidance` dictionary block; everything it
// points at is a `data-tour-id`; which tours exist is src/lib/tours.ts.

interface TourContextValue {
  /** Start a tour by id now (e.g. from a "show me around" control). */
  start: (tourId: string) => void;
  activeTourId: string | null;
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTour(): TourContextValue {
  return useContext(TourContext) ?? { start: () => {}, activeTourId: null };
}

function visibleSteps(tour: TourDef): TourStep[] {
  return tour.steps.filter((s) => targetElement(s.targetId) !== null);
}

function autostartSuppressed(): boolean {
  try {
    return window.localStorage.getItem(GUIDANCE_AUTOSTART_KEY) === 'off';
  } catch {
    return false;
  }
}

export function TourProvider({ role, autostart = true, children }: { role: string; autostart?: boolean; children: ReactNode }) {
  const t = useT();
  const g = t.guidance;
  const [active, setActive] = useState<{ tour: TourDef; steps: TourStep[]; index: number } | null>(null);

  const start = useCallback((tourId: string) => {
    const tour = tourById(tourId);
    if (!tour) return;
    const steps = visibleSteps(tour);
    // Nothing to point at here (e.g. the sidebar is folded into a drawer):
    // not shown and not recorded, so it is offered again where it fits.
    if (steps.length > 0) setActive({ tour, steps, index: 0 });
  }, []);

  useEffect(() => {
    const tour = firstRunTourFor(role);
    if (!autostart || !tour || autostartSuppressed()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    fetch('/api/guidance')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || d?.tours?.[tour.id] !== 'new') return;
        // Let the shell finish laying out its navigation before measuring it.
        timer = setTimeout(() => !cancelled && start(tour.id), 400);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [role, autostart, start]);

  const finish = useCallback((tour: TourDef, outcome: TourOutcome) => {
    setActive(null);
    fetch('/api/guidance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tourId: tour.id, outcome }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const value = useMemo(() => ({ start, activeTourId: active?.tour.id ?? null }), [start, active]);

  const step = active ? active.steps[active.index] : null;
  const copy = active ? (g.tours as Record<string, { steps: Record<string, { title: string; body: string }> }>)[active.tour.id]?.steps[step!.key] : null;

  return (
    <TourContext.Provider value={value}>
      {children}
      {active && step && copy && (
        <Coachmark
          key={active.tour.id}
          targetId={step.targetId}
          placement={step.placement}
          title={copy.title}
          body={copy.body}
          index={active.index}
          total={active.steps.length}
          labels={{ next: g.next, back: g.back, skip: g.skip, done: g.done, progress: g.progress }}
          onNext={() =>
            active.index === active.steps.length - 1
              ? finish(active.tour, 'completed')
              : setActive({ ...active, index: active.index + 1 })
          }
          onBack={() => setActive({ ...active, index: Math.max(0, active.index - 1) })}
          onSkip={() => finish(active.tour, 'dismissed')}
        />
      )}
    </TourContext.Provider>
  );
}
