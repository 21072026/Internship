// THE domain-event catalogue (#1691): every event the product can raise, once.
//
// WHAT AN ENTRY IS
//   A `name` + `version` pair, the kind of record it is about (`subjectType`,
//   plus the payload field holding that record's id when the payload has one),
//   a zod schema for the payload, a `visibility`, and one line of description.
//   The pair is the identity: a payload change that would break a receiver is a
//   NEW entry with `version: 2` next to the old one, never an edit of version 1.
//   Webhook receivers, the outbox relay (#1680), `emit()` (#1693), the webhook
//   delivery log (#1695) and automation rules (#1703) all read this file and
//   nothing else.
//
// THE PUBLIC ENTRIES ARE A PUBLISHED CONTRACT
//   `visibility: 'public'` events are what a tenant can subscribe a webhook to,
//   and their names are served unauthenticated in the `x-webhooks` block of
//   /api/v1/openapi.json. `WEBHOOK_EVENTS` below is DERIVED from them, in this
//   file's order, and `src/lib/webhooks.ts` re-exports it — so the order of the
//   public entries is the order of that published list. Do not reorder, rename
//   or reshape them; add a version instead.
//
//   The version-1 payload schemas are exactly what the producers dispatch today,
//   read off each call site, and they are `.strict()`: an extra key is a shape
//   change, and a shape change is a new version. Three events have more than
//   one producer and therefore more than one shape under one name —
//   `meeting.scheduled` (batch invite / instant meeting / recurring series) and
//   `interaction.logged` (by hand / auto-logged). Version 1 describes all of
//   them as they are, with the producer-specific keys optional, because that is
//   what receivers have been getting. Reconciling them is a version 2.
//
//   Several public events are registered but not raised yet (their producer
//   has not been written; it calls `emit()`, src/lib/events/emit.ts). Their schemas are the shape they
//   WILL ship with — ids only, no personal data — and the first producer is
//   held to it.
//
// NOT THE NOTIFICATION CATALOGUE
//   `src/lib/notifications/catalog.ts` is a separate vocabulary on purpose: it
//   names what a PERSON IS TOLD (keys the dictionary and every
//   `Notification.type` row already use), this file names what HAPPENED. One
//   event may cause zero, one or several notifications — a
//   `pipeline.stage_change` here is what makes a `stage.changed` notification
//   there — and neither file derives from the other. docs/domain-events.md.
//
// Dependency-free apart from zod, so it is safe to import from client code, a
// unit test or a script.

import { z } from 'zod';

/** Who caused an event. Stored on `DomainEvent.actorType`. */
export const EVENT_ACTOR_TYPES = ['user', 'system', 'apikey'] as const;
export type EventActorType = (typeof EVENT_ACTOR_TYPES)[number];

export type EventVisibility = 'public' | 'internal';

/** Longest name `DomainEvent.name` (@db.VarChar(96)) can hold. */
export const EVENT_NAME_MAX = 96;

// A timestamp as producers send it: `Date#toISOString()`.
const isoInstant = z.string().datetime();
const id = z.string().min(1);

// One field of a configuration diff, as `redactedDiff()` returns it (#1699).
const diffValue = z.union([z.string(), z.number(), z.boolean()]).nullable();
const configChanges = z
  .array(
    z
      .object({
        field: z.string().min(1),
        from: diffValue,
        to: diffValue,
        redacted: z.literal(true).optional(),
        fromFingerprint: z.string().nullable().optional(),
        toFingerprint: z.string().nullable().optional(),
      })
      .strict(),
  )
  .min(1);

export interface EventDefinition {
  name: string;
  version: number;
  /** The kind of record the event is about — a Prisma model name. */
  subjectType: string;
  /** The payload field carrying the subject's id, when the payload has one. */
  subjectKey?: string;
  payload: z.ZodTypeAny;
  visibility: EventVisibility;
  /** One line, receiver-facing. */
  description: string;
}

export const EVENT_CATALOG = [
  // ── Public: the webhook contract. ORDER IS PUBLISHED (see header). ─────────
  {
    name: 'application.created',
    version: 1,
    subjectType: 'User',
    // The applicant's id is not in the v1 payload (/api/apply sends the name
    // and address it was given); a v2 would carry it and drop the PII.
    payload: z.object({ mentorId: id, menteeName: z.string(), email: z.string() }).strict(),
    visibility: 'public',
    description: 'Someone applied to a mentor through the public application form.',
  },
  {
    name: 'pipeline.stage_change',
    version: 1,
    subjectType: 'MentorshipRelation',
    subjectKey: 'relationId',
    payload: z.object({ relationId: id, from: z.string(), to: z.string() }).strict(),
    visibility: 'public',
    description: "A mentorship moved to another pipeline stage (`from` and `to` are stage keys).",
  },
  {
    name: 'mentorship.created',
    version: 1,
    subjectType: 'MentorshipRelation',
    subjectKey: 'relationId',
    payload: z
      .object({ relationId: id, mentorId: id, menteeId: id, companyId: id.nullable() })
      .strict(),
    visibility: 'public',
    description: 'A mentor was assigned to a mentee.',
  },
  {
    name: 'interaction.logged',
    version: 1,
    subjectType: 'MentorshipRelation',
    subjectKey: 'relationId',
    // Two producers: logged by hand (/api/interactions) and auto-logged from a
    // finished meeting (meetingAutoLog.ts, which adds `autoLogged: true`).
    payload: z
      .object({ relationId: id, type: z.string(), date: isoInstant, autoLogged: z.literal(true).optional() })
      .strict(),
    visibility: 'public',
    description: 'An interaction (meeting, feedback, e-mail …) was logged on a mentorship.',
  },
  {
    name: 'evaluation.added',
    version: 1,
    subjectType: 'MentorshipRelation',
    subjectKey: 'relationId',
    payload: z.object({ relationId: id, type: z.string(), authorId: id }).strict(),
    visibility: 'public',
    description: 'An evaluation was submitted for a mentorship.',
  },
  {
    name: 'meeting.scheduled',
    version: 1,
    subjectType: 'Meeting',
    // Three producers, one name: the batch invite ({title, scheduledAt, count}),
    // the instant meeting (scheduledAt null, `instant: true`) and the recurring
    // series (`seriesId`). No meeting id in v1 — a batch is several meetings.
    payload: z
      .object({
        title: z.string(),
        scheduledAt: isoInstant.nullable(),
        count: z.number().int().nonnegative(),
        instant: z.literal(true).optional(),
        seriesId: id.optional(),
      })
      .strict(),
    visibility: 'public',
    description: 'One or more meetings were scheduled (a batch, an instant meeting or a series occurrence).',
  },
  {
    name: 'meeting.rescheduled',
    version: 1,
    subjectType: 'Meeting',
    subjectKey: 'meetingId',
    payload: z
      .object({ meetingId: id, scheduledAt: isoInstant, previousScheduledAt: isoInstant.nullable() })
      .strict(),
    visibility: 'public',
    description: 'A meeting moved to another time.',
  },
  {
    name: 'meeting.cancelled',
    version: 1,
    subjectType: 'Meeting',
    subjectKey: 'meetingId',
    payload: z
      .object({ meetingId: id, scheduledAt: isoInstant.nullable(), count: z.number().int().positive() })
      .strict(),
    visibility: 'public',
    description: 'A meeting (or `count` meetings of one batch) was called off.',
  },
  {
    name: 'interview_panel.completed',
    version: 1,
    subjectType: 'InterviewPanel',
    subjectKey: 'panelId',
    payload: z.object({ panelId: id, subjectId: id }).strict(),
    visibility: 'public',
    description: 'Every interviewer on a panel has scored, or an admin closed it.',
  },
  {
    name: 'interview_panel.outcome',
    version: 1,
    subjectType: 'InterviewPanel',
    subjectKey: 'panelId',
    payload: z
      .object({ panelId: id, applicationId: id, outcome: z.enum(['ADVANCE', 'REJECT', 'OFFER']) })
      .strict(),
    visibility: 'public',
    description: "A closed panel's decision was recorded.",
  },
  {
    name: 'interview_request.scheduled',
    version: 1,
    subjectType: 'InterviewRequest',
    subjectKey: 'requestId',
    payload: z
      .object({ requestId: id, meetingId: id, scheduledAt: isoInstant, panelId: id.nullable() })
      .strict(),
    visibility: 'public',
    description: 'An approved interview request got a meeting.',
  },
  {
    name: 'interview_request.cancelled',
    version: 1,
    subjectType: 'InterviewRequest',
    subjectKey: 'requestId',
    payload: z.object({ requestId: id, meetingId: id.nullable() }).strict(),
    visibility: 'public',
    description: 'An interview request was called off.',
  },
  {
    name: 'offer.accepted',
    version: 1,
    subjectType: 'Offer',
    subjectKey: 'offerId',
    payload: z.object({ offerId: id, applicationId: id.nullable(), requisitionId: id.nullable() }).strict(),
    visibility: 'public',
    description: 'The candidate accepted an offer.',
  },
  {
    name: 'offer.declined',
    version: 1,
    subjectType: 'Offer',
    subjectKey: 'offerId',
    payload: z.object({ offerId: id, applicationId: id.nullable(), requisitionId: id.nullable() }).strict(),
    visibility: 'public',
    description: 'The candidate declined an offer.',
  },
  {
    name: 'requisition.filled',
    version: 1,
    subjectType: 'Requisition',
    subjectKey: 'requisitionId',
    // Raised once: by the acceptance that took the last opening.
    payload: z.object({ requisitionId: id, offerId: id }).strict(),
    visibility: 'public',
    description: 'An acceptance took the last opening of a requisition.',
  },
  {
    // A pairing paused, resumed, ended or reopened (#1770). Registered, not yet
    // raised — its first producer calls emit() (a direct dispatcher call is
    // refused by scripts/check-events.mjs). `from`/`to` are lifecycle states; `reasonCode` is set on an end
    // only (LIFECYCLE_END_REASON_CODES), null otherwise.
    name: 'mentorship.lifecycle_changed',
    version: 1,
    subjectType: 'MentorshipRelation',
    subjectKey: 'relationId',
    payload: z
      .object({ relationId: id, from: z.string(), to: z.string(), reasonCode: z.string().nullable() })
      .strict(),
    visibility: 'public',
    description: 'A mentorship was paused, resumed, ended or reopened (`from` and `to` are lifecycle states).',
  },
  {
    // One producer, by construction: moveApplicationStage() is the one writer
    // of Application.stage (#1836); stageTransaction() raises the event after
    // its caller's transaction commits (src/lib/applicationStageEvents.ts).
    // A creation is not a stage change — `from` is always a stage key. No
    // note, no disposition code (#1998).
    name: 'application.stage_changed',
    version: 1,
    subjectType: 'Application',
    subjectKey: 'applicationId',
    payload: z.object({ applicationId: id, requisitionId: id, from: z.string(), to: z.string() }).strict(),
    visibility: 'public',
    description: "A candidate's application for a requisition moved to another stage (`from` and `to` are stage keys, e.g. SHORTLISTED → INTERVIEW).",
  },
  {
    // One producer: transferMentorship() (src/lib/mentorTransfer.ts, #2289),
    // the one way a mentee's mentor changes. `corrected` = the pairing had no
    // history and its mentor was fixed in place (relationId is the same row,
    // previousRelationId null); `transferred` = the old pairing closed as
    // ENDED_REASSIGNED and `relationId` is its successor. The reason is the
    // code only — the admin's free-text note never leaves the activity log.
    name: 'mentorship.transferred',
    version: 1,
    subjectType: 'MentorshipRelation',
    subjectKey: 'relationId',
    payload: z
      .object({
        relationId: id,
        previousRelationId: id.nullable(),
        menteeId: id,
        fromMentorId: id,
        toMentorId: id,
        mode: z.enum(['corrected', 'transferred']),
        reasonCode: z.string(),
      })
      .strict(),
    visibility: 'public',
    description: "A mentee's mentor changed — corrected in place, or a new pairing that carries the stage over.",
  },
  // The rest of the offer lifecycle (#1998), same shape as offer.accepted —
  // ids only, never the position or compensation. Producers: PATCH
  // /api/offers/[id] and the expiry sweep, both through raiseOfferEvent().
  {
    name: 'offer.sent',
    version: 1,
    subjectType: 'Offer',
    subjectKey: 'offerId',
    payload: z.object({ offerId: id, applicationId: id.nullable(), requisitionId: id.nullable() }).strict(),
    visibility: 'public',
    description: 'An offer was sent to the candidate.',
  },
  {
    name: 'offer.withdrawn',
    version: 1,
    subjectType: 'Offer',
    subjectKey: 'offerId',
    payload: z.object({ offerId: id, applicationId: id.nullable(), requisitionId: id.nullable() }).strict(),
    visibility: 'public',
    description: 'A sent offer was withdrawn before the candidate decided.',
  },
  {
    name: 'offer.expired',
    version: 1,
    subjectType: 'Offer',
    subjectKey: 'offerId',
    payload: z.object({ offerId: id, applicationId: id.nullable(), requisitionId: id.nullable() }).strict(),
    visibility: 'public',
    description: 'A sent offer passed its expiry date without a decision.',
  },
  // The interview request before it is scheduled (#1998). The company asks
  // (POST /api/interview-requests), the programme decides (POST
  // /api/interview-requests/[id]); `.scheduled` / `.cancelled` follow above.
  // Ids and codes only — never the company's note or the decline note.
  {
    name: 'interview_request.created',
    version: 1,
    subjectType: 'InterviewRequest',
    subjectKey: 'requestId',
    payload: z.object({ requestId: id, requisitionId: id, menteeId: id, companyId: id }).strict(),
    visibility: 'public',
    description: 'A company asked to interview a shortlisted candidate for a requisition.',
  },
  {
    name: 'interview_request.approved',
    version: 1,
    subjectType: 'InterviewRequest',
    subjectKey: 'requestId',
    payload: z.object({ requestId: id, requisitionId: id, menteeId: id }).strict(),
    visibility: 'public',
    description: 'The programme approved an interview request; scheduling comes next.',
  },
  {
    name: 'interview_request.declined',
    version: 1,
    subjectType: 'InterviewRequest',
    subjectKey: 'requestId',
    payload: z.object({ requestId: id, requisitionId: id, menteeId: id, reasonCode: z.string() }).strict(),
    visibility: 'public',
    description: 'The programme declined an interview request (`reasonCode` is a decline code, never the note).',
  },
  {
    // One producer: POST /api/company/interests, on a genuine status change
    // only (a note-only save raises nothing). `from` is null for a new flag.
    name: 'company_interest.changed',
    version: 1,
    subjectType: 'CompanyInterest',
    subjectKey: 'interestId',
    payload: z
      .object({
        interestId: id,
        companyId: id,
        menteeId: id,
        requisitionId: id.nullable(),
        from: z.string().nullable(),
        to: z.string(),
      })
      .strict(),
    visibility: 'public',
    description: 'A company flagged a candidate as interesting, shortlisted or passed (`from` and `to` are interest states).',
  },

  // ── Internal: recorded and subscribable inside the product, never a webhook. ─
  // Ids only: a payload that needs a person's name or address reads it from
  // the record at delivery time, so pruning the event table is never the only
  // way to forget somebody.
  //
  // The configuration events (#1699) also carry `changes`: the redacted
  // before/after diff `redactedDiff()` (src/lib/events/diff.ts) computed from
  // the row read BEFORE the write and the row after it. A secret never reaches
  // it — a redacted field is `[redacted]` plus a short fingerprint. Their v1
  // shapes were reshaped in place by #1699, before any producer had raised one.
  {
    name: 'org.config.changed',
    version: 1,
    subjectType: 'Organization',
    subjectKey: 'orgId',
    payload: z.object({ orgId: id, changes: configChanges }).strict(),
    visibility: 'internal',
    description: "An organisation's configuration changed (a redacted before/after diff).",
  },
  {
    name: 'setting.changed',
    version: 1,
    subjectType: 'Setting',
    subjectKey: 'key',
    payload: z
      .object({
        key: z.string().min(1),
        scope: z.enum(['global', 'org', 'program']),
        programId: id.nullable(),
        changes: configChanges,
      })
      .strict(),
    visibility: 'internal',
    description: 'A setting was written or reverted to its inherited value, at one scope (a redacted before/after diff).',
  },
  {
    name: 'webhook.registered',
    version: 1,
    subjectType: 'Webhook',
    subjectKey: 'webhookId',
    payload: z.object({ webhookId: id, events: z.array(z.string()).min(1), changes: configChanges }).strict(),
    visibility: 'internal',
    description: 'An admin registered a webhook receiver.',
  },
  {
    name: 'webhook.updated',
    version: 1,
    subjectType: 'Webhook',
    subjectKey: 'webhookId',
    payload: z.object({ webhookId: id, changes: configChanges }).strict(),
    visibility: 'internal',
    description: 'An admin re-pointed, re-scoped, paused or resumed a webhook receiver.',
  },
  {
    name: 'webhook.deleted',
    version: 1,
    subjectType: 'Webhook',
    subjectKey: 'webhookId',
    payload: z.object({ webhookId: id, changes: configChanges }).strict(),
    visibility: 'internal',
    description: 'An admin deleted a webhook receiver.',
  },
  {
    name: 'apikey.created',
    version: 1,
    subjectType: 'ApiKey',
    subjectKey: 'apiKeyId',
    payload: z.object({ apiKeyId: id, changes: configChanges }).strict(),
    visibility: 'internal',
    description: 'An API key was minted.',
  },
  {
    name: 'apikey.revoked',
    version: 1,
    subjectType: 'ApiKey',
    subjectKey: 'apiKeyId',
    payload: z.object({ apiKeyId: id }).strict(),
    visibility: 'internal',
    description: 'An API key was revoked.',
  },
  {
    name: 'relation.created',
    version: 1,
    subjectType: 'MentorshipRelation',
    subjectKey: 'relationId',
    payload: z.object({ relationId: id, mentorId: id, menteeId: id }).strict(),
    visibility: 'internal',
    description: 'A mentorship relation row was created by any path (assignment, transfer, import).',
  },
  {
    name: 'meeting.completed',
    version: 1,
    subjectType: 'Meeting',
    subjectKey: 'meetingId',
    payload: z.object({ meetingId: id, relationId: id.nullable() }).strict(),
    visibility: 'internal',
    description: 'A meeting took place.',
  },
  {
    name: 'user.invited',
    version: 1,
    subjectType: 'InvitationToken',
    subjectKey: 'invitationId',
    payload: z.object({ invitationId: id, role: z.string() }).strict(),
    visibility: 'internal',
    description: 'An invitation was issued.',
  },
  {
    name: 'email.bounced',
    version: 1,
    subjectType: 'User',
    subjectKey: 'userId',
    payload: z.object({ userId: id.nullable(), kind: z.enum(['hard', 'soft', 'complaint']) }).strict(),
    visibility: 'internal',
    description: 'A mail to an account bounced or was reported as spam.',
  },
] as const satisfies readonly EventDefinition[];

type CatalogEntry = (typeof EVENT_CATALOG)[number];

/** Every event name the product knows, public and internal. */
export type DomainEventName = CatalogEntry['name'];
/** The subscribable subset — the published webhook vocabulary. */
export type PublicEventName = Extract<CatalogEntry, { visibility: 'public' }>['name'];

/** The payload type of one event at one version (default: version 1). */
export type EventPayload<N extends DomainEventName, V extends number = 1> = z.infer<
  Extract<CatalogEntry, { name: N; version: V }>['payload']
>;

/**
 * The public event names, in catalogue order — the list a webhook subscribes
 * from and /api/v1/openapi.json publishes. A tuple type so `z.enum()` takes it.
 */
export const WEBHOOK_EVENTS = [
  ...new Set(EVENT_CATALOG.filter((e) => e.visibility === 'public').map((e) => e.name)),
] as unknown as readonly [PublicEventName, ...PublicEventName[]];

/** Every distinct event name, in catalogue order. */
export const DOMAIN_EVENT_NAMES: readonly DomainEventName[] = [...new Set(EVENT_CATALOG.map((e) => e.name))];

export function isDomainEventName(name: string): name is DomainEventName {
  return (DOMAIN_EVENT_NAMES as readonly string[]).includes(name);
}

/** The highest version the catalogue declares for `name`, or null for an unknown name. */
export function latestEventVersion(name: string): number | null {
  let best: number | null = null;
  for (const e of EVENT_CATALOG) if (e.name === name && (best === null || e.version > best)) best = e.version;
  return best;
}

/** One entry; the latest version when `version` is omitted. */
export function getEventDefinition(name: string, version?: number): EventDefinition | null {
  const v = version ?? latestEventVersion(name);
  if (v === null) return null;
  return (EVENT_CATALOG as readonly EventDefinition[]).find((e) => e.name === name && e.version === v) ?? null;
}

export type EventPayloadCheck =
  | { ok: true; definition: EventDefinition; payload: Record<string, unknown> }
  | { ok: false; reason: 'unknown_event' | 'invalid_payload'; issues?: string[] };

/**
 * Check a payload against its catalogue entry. The one runtime gate a producer
 * goes through (`emit()`, #1693); never throws.
 */
export function validateEventPayload(name: string, payload: unknown, version?: number): EventPayloadCheck {
  const definition = getEventDefinition(name, version);
  if (!definition) return { ok: false, reason: 'unknown_event' };
  const parsed = definition.payload.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_payload',
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { ok: true, definition, payload: parsed.data as Record<string, unknown> };
}

/** The subject id an event's payload names, per its entry's `subjectKey`. */
export function eventSubjectId(definition: EventDefinition, payload: Record<string, unknown>): string | null {
  if (!definition.subjectKey) return null;
  const v = payload[definition.subjectKey];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
