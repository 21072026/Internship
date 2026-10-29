// Segment → database (#1684): the ONE place a nudge segment reaches Prisma.
//
// A segment is admin-authored JSON — a user-authored query reaching the
// database — so nothing in it is passed through. `segmentUserWhere()` builds
// the `where` from the parsed, allowlisted conditions only (./rule.ts
// `segmentConditionSchema`, strict): each field maps to a fixed column, each
// operator to a fixed Prisma operator, each value is a typed literal. A field
// or operator this file does not know cannot get here, because the schema
// refused it when the rule was stored and `readStoredNudge()` refuses it again
// when it is read back.
//
// Two halves, deliberately: the `where` is a COARSE superset the database can
// answer with indexes; `relationMatches()` then judges every candidate's
// active relations EXACTLY in code — "days in stage" through the one stage
// clock (src/lib/stageClock.ts), which a `where` cannot express without
// comparing two columns. A person is in the segment when the coarse `where`
// returns them AND (if the segment has relation conditions) one of their
// active relations in that role matches all of them.

import type { Prisma } from '@prisma/client';
import { daysInStage, DAY_MS } from '@/lib/stageClock';
import { segmentRoles, type Segment, type SegmentCondition } from './rule';

const RELATION_FIELDS = new Set<SegmentCondition['field']>(['stage', 'daysInStage', 'daysSinceLastInteraction', 'cohort']);

export function hasRelationConditions(segment: Segment): boolean {
  return segment.conditions.some((c) => RELATION_FIELDS.has(c.field));
}

/** The coarse `where` for one role. Explicit `orgId` — the evaluator runs with no session. */
function roleWhere(role: 'MENTOR' | 'MENTEE', segment: Segment, orgId: string, now: Date): Prisma.UserWhereInput {
  const rel: Prisma.MentorshipRelationWhereInput[] = [{ status: 'ACTIVE', orgId }];
  const user: Prisma.UserWhereInput[] = [];
  for (const c of segment.conditions) {
    switch (c.field) {
      case 'role':
        break;
      case 'stage':
        rel.push({ pipelineStatus: c.op === 'in' ? { in: [...c.value] } : { notIn: [...c.value] } });
        break;
      case 'cohort':
        rel.push({ cohortId: { in: [...c.value] } });
        break;
      case 'daysInStage':
        // Coarse: a relation younger than N days cannot have sat N days in a
        // stage. The exact clock is relationMatches().
        if (c.op === 'gte') rel.push({ startDate: { lte: new Date(now.getTime() - c.value * DAY_MS) } });
        break;
      case 'daysSinceLastInteraction': {
        const cutoff = new Date(now.getTime() - c.value * DAY_MS);
        rel.push({ startDate: { lte: cutoff }, interactions: { none: { date: { gte: cutoff } } } });
        break;
      }
      case 'tag':
        user.push(c.op === 'has' ? { tags: { some: { tagId: c.value } } } : { tags: { none: { tagId: c.value } } });
        break;
      case 'hasNoMentor':
        // A mentee-only fact; a mentor never matches a hasNoMentor condition.
        if (role === 'MENTOR') return { id: { in: [] } };
        user.push(c.value ? { menteeRelations: { none: { status: 'ACTIVE', orgId } } } : { menteeRelations: { some: { status: 'ACTIVE', orgId } } });
        break;
    }
  }
  const relWhere: Prisma.MentorshipRelationWhereInput = { AND: rel };
  if (hasRelationConditions(segment)) {
    user.push(role === 'MENTOR' ? { mentorRelations: { some: relWhere } } : { menteeRelations: { some: relWhere } });
  }
  return { role, AND: user };
}

/** Every person the segment can describe in `orgId`: active MENTOR/MENTEE rows only. */
export function segmentUserWhere(segment: Segment, orgId: string, now: Date, restrictTo?: readonly string[]): Prisma.UserWhereInput {
  return {
    orgId,
    isActive: true,
    ...(restrictTo ? { id: { in: [...restrictTo] } } : {}),
    OR: segmentRoles(segment).map((r) => roleWhere(r, segment, orgId, now)),
  };
}

/** One active relation as `relationMatches()` needs it. */
export interface SegmentRelation {
  pipelineStatus: string;
  cohortId: string | null;
  startDate: Date;
  statusChanges: { createdAt: Date; fromStatus: string; toStatus: string }[];
  /** The newest interaction's date, or null. */
  lastInteractionAt: Date | null;
}

/** Does this relation satisfy EVERY relation-level condition, exactly? */
export function relationMatches(segment: Segment, rel: SegmentRelation, now: Date): boolean {
  for (const c of segment.conditions) {
    switch (c.field) {
      case 'stage': {
        const inList = c.value.includes(rel.pipelineStatus);
        if (c.op === 'in' ? !inList : inList) return false;
        break;
      }
      case 'cohort':
        if (!rel.cohortId || !c.value.includes(rel.cohortId)) return false;
        break;
      case 'daysInStage': {
        const d = daysInStage(rel, now.getTime());
        if (c.op === 'gte' ? d < c.value : d > c.value) return false;
        break;
      }
      case 'daysSinceLastInteraction': {
        const since = rel.lastInteractionAt ?? rel.startDate;
        if (now.getTime() - since.getTime() < c.value * DAY_MS) return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}
