// `mentorship.lifecycle_changed` (#1770 / #1998) — one builder for every writer
// of a pairing's lifecycle state. Server-only.
//
// The writers: POST /api/mentorship/[id]/lifecycle (pause, resume, end,
// reopen), transferMentorship() (ENDED_REASSIGNED), the re-match approval in
// mentorshipDecision.ts (ENDED_REMATCHED) and winBack() (ENDED_CHURNED). Each
// calls this after its own commit — never inside a transaction it does not own.
// The machine importer (src/lib/migration/runMigration.ts) sets the initial
// state of records it brings in; that is data arriving, not a pairing moving,
// and raises nothing.
//
// `reasonCode` is a code (LIFECYCLE_END_REASON_CODES, or the transfer's admin
// code) or null; the free-text note never goes on the bus (#1801).
import { emit } from '@/lib/events/emit';

export function raiseLifecycleChanged(input: {
  relationId: string;
  orgId: string | null;
  from: string;
  to: string;
  reasonCode: string | null;
  actorId: string | null;
}): Promise<string | null> {
  return emit(
    'mentorship.lifecycle_changed',
    { relationId: input.relationId, from: input.from, to: input.to, reasonCode: input.reasonCode },
    { orgId: input.orgId, actor: input.actorId ? { id: input.actorId, type: 'user' } : { id: null, type: 'system' } },
  );
}
