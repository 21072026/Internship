// In-app tours (#2067) — the registry. Client-safe and dependency-free; unit-
// tested in scripts/test/tours.test.mjs.
//
// A tour is DATA: which role gets it, and an ordered list of steps, each
// anchored to an element by its `data-tour-id` attribute (never a CSS selector
// a refactor breaks) and worded by keys of the `guidance.tours` dictionary
// block. Adding a tour is an entry here plus its EN/TR/DE strings — no new
// component. The runtime is src/components/guidance/TourProvider.tsx.
//
// A step whose target is not on the screen (a capability the org lacks, the
// sidebar folded away on a phone) is skipped; a tour with no visible step is
// not offered at all and is NOT recorded as seen, so it is offered again where
// it can actually be shown.

export type TourPlacement = 'right' | 'bottom' | 'left' | 'top';

export interface TourStep {
  /** The `data-tour-id` of the element the step points at. */
  targetId: string;
  /** Key under `guidance.tours.<tourId>.steps` holding `{ title, body }`. */
  key: string;
  placement: TourPlacement;
}

export interface TourDef {
  id: string;
  /** The role whose shell offers it automatically on a first visit. */
  role: 'ADMIN' | 'MENTOR';
  steps: readonly TourStep[];
}

export const TOURS = [
  {
    id: 'admin-first-run',
    role: 'ADMIN',
    steps: [
      { targetId: 'nav-board', key: 'board', placement: 'right' },
      { targetId: 'nav-candidates', key: 'candidates', placement: 'right' },
      { targetId: 'nav-users', key: 'invite', placement: 'right' },
      { targetId: 'nav-settings', key: 'settings', placement: 'right' },
    ],
  },
  {
    id: 'mentor-first-run',
    role: 'MENTOR',
    steps: [
      { targetId: 'nav-myMentees', key: 'mentees', placement: 'right' },
      { targetId: 'nav-board', key: 'board', placement: 'right' },
      { targetId: 'nav-interactionLogs', key: 'interactions', placement: 'right' },
    ],
  },
] as const satisfies readonly TourDef[];

export type TourId = (typeof TOURS)[number]['id'];

export function tourById(id: string): TourDef | null {
  return (TOURS as readonly TourDef[]).find((t) => t.id === id) ?? null;
}

/** The tour a role's shell offers on a first visit, if any. */
export function firstRunTourFor(role: string | null | undefined): TourDef | null {
  return (TOURS as readonly TourDef[]).find((t) => t.role === role) ?? null;
}

/** The UserGuidanceState key a tour's seen/dismissed state lives under. */
export function tourGuidanceKey(id: string): string {
  return `tour:${id}`;
}

/** What a finished or abandoned tour records. */
export type TourOutcome = 'completed' | 'dismissed';

/**
 * A per-BROWSER switch that suppresses only the automatic offer — the e2e
 * suite seeds it (e2e/global-setup.ts, like the cookie-consent choice) so a
 * first-run tour does not open over every other spec's first page. The record
 * of what a person has seen stays on the server; this never writes it, and a
 * person can still start a tour themselves.
 */
export const GUIDANCE_AUTOSTART_KEY = 'guidance-autostart';
