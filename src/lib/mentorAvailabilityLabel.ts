// Shared "capacity · status" suffix for an admin mentor picker row (#942), e.g.
// "3 / 4 · Available" or "Capacity not set · Not accepting". Two admin UIs
// render this next to a mentor's name — AssignMentorInline.tsx (candidates
// screen) and the assign form on /admin/mentorship — kept in one place so the
// shape never drifts between them. Availability itself must still come from
// getMentorAvailability() (src/lib/mentorAvailability.ts); this only formats it.

import type { MentorAvailability } from './mentorAvailability';

export interface MentorAvailabilityLabelInput {
  mentorCapacity: number | null | undefined;
  activeMenteeCount: number;
  availability: Pick<MentorAvailability, 'status' | 'capacityKnown'>;
}

// Matches the shape of the `mentorAvailability` i18n block — passed in rather
// than imported so this stays a plain, framework-free function the two React
// call sites can each feed their own `t.mentorAvailability`.
export interface MentorAvailabilityLabelStrings {
  available: string;
  atCapacity: string;
  notAccepting: string;
  capacityNotSet: string;
  // '{active} / {capacity}', e.g. '3 / 4'.
  activeCount: string;
}

export function formatMentorAvailability(
  { mentorCapacity, activeMenteeCount, availability }: MentorAvailabilityLabelInput,
  strings: MentorAvailabilityLabelStrings
): string {
  const capacityPart = availability.capacityKnown
    ? strings.activeCount.replace('{active}', String(activeMenteeCount)).replace('{capacity}', String(mentorCapacity))
    : strings.capacityNotSet;

  const statusPart =
    availability.status === 'at_capacity'
      ? strings.atCapacity
      : availability.status === 'not_accepting'
        ? strings.notAccepting
        : strings.available;

  return `${capacityPart} · ${statusPart}`;
}
