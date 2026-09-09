// The catalogue's type safety, asserted (#1710).
//
// "An unknown event key does not compile; a payload missing a required field
// does not compile" is a deliverable of the router, and a deliverable nothing
// checks is a deliverable that quietly stops being true — a `params: string[]`
// that loses its `as const`, or an `EventPayload` mapped type widened to
// `Record<string, unknown>` while refactoring, both keep the whole app
// compiling and silently accept anything.
//
// `@ts-expect-error` is the assertion. TypeScript fails the build when an
// expectation is UNUSED, so each line below fails `npx tsc --noEmit` (which CI
// runs) the moment the mistake it names stops being a mistake. This is the
// compile-time half of the coverage; the runtime and dictionary-parity half is
// scripts/test/notification-catalog.test.mjs.
//
// Nothing here is ever executed. The functions exist because a *call* is what
// exercises the generic; no other module imports them, so no bundle contains
// them. Keep them uncalled.

import { notifyEvent } from '@/lib/notifications/router';

export async function acceptsAKnownEventWithItsFullPayload() {
  await notifyEvent('user-id', 'deadline.stagePassed', { menteeName: 'A', relationId: 'r1' });
  // Link ids are optional on every payload — a missing one degrades to the
  // recipient's role root inside notificationLink().
  await notifyEvent('user-id', 'deadline.stagePassed', { menteeName: 'A' });
  // An event with no placeholders takes an empty payload.
  await notifyEvent('user-id', 'evaluation.added', {});
  // Numbers are renderable values, not just strings.
  await notifyEvent('user-id', 'project.newTodos', { count: 3 });
}

export async function rejectsAnEventThatIsNotInTheCatalogue() {
  // @ts-expect-error 'nope.notAnEvent' is not a catalogue key
  await notifyEvent('user-id', 'nope.notAnEvent', {});
}

export async function rejectsAPayloadMissingARequiredPlaceholder() {
  // @ts-expect-error 'deadline.stagePassed' interpolates {menteeName}
  await notifyEvent('user-id', 'deadline.stagePassed', { relationId: 'r1' });
}

export async function rejectsAPlaceholderThatCannotBeInterpolated() {
  // @ts-expect-error only string | number can be substituted into a template
  await notifyEvent('user-id', 'deadline.stagePassed', { menteeName: { first: 'A' } });
}

export async function rejectsAnotherEventsPayload() {
  // @ts-expect-error 'stage.changed' interpolates {from} and {to}, not {menteeName}
  await notifyEvent('user-id', 'stage.changed', { menteeName: 'A' });
}
