import { test, expect } from '@playwright/test';
import {
  DOMAIN_EVENT_NAMES,
  EVENT_CATALOG,
  EVENT_NAME_MAX,
  WEBHOOK_EVENTS,
  eventSubjectId,
  getEventDefinition,
  latestEventVersion,
  validateEventPayload,
} from '@/lib/events/catalog';
import { WEBHOOK_EVENTS as REEXPORTED } from '@/lib/webhooks';

// The versioned domain-event catalogue (#1691), without a database.
//
// Two things are a published contract and are pinned LITERALLY here, not
// derived: the public event list (it is served in /api/v1/openapi.json, in this
// order) and the payload each producer sends today. A test that compared the
// catalogue with itself could not notice either one drifting.

const PUBLISHED = [
  'application.created',
  'pipeline.stage_change',
  'mentorship.created',
  'interaction.logged',
  'evaluation.added',
  'meeting.scheduled',
  'meeting.rescheduled',
  'meeting.cancelled',
  'interview_panel.completed',
  'interview_panel.outcome',
  'interview_request.scheduled',
  'interview_request.cancelled',
  'offer.accepted',
  'offer.declined',
  'requisition.filled',
  'mentorship.lifecycle_changed',
  'application.stage_changed',
  'mentorship.transferred',
  'offer.sent',
  'offer.withdrawn',
  'offer.expired',
];

const at = '2026-10-20T09:30:00.000Z';

// One object per producer call site, copied from the call as it reads today
// (grep -rn "emit('" src/ — they called dispatchWebhook() directly before
// #1697). Ten call sites, ten shapes.
const PRODUCERS: [site: string, event: string, payload: Record<string, unknown>][] = [
  ['api/apply', 'application.created', { mentorId: 'u1', menteeName: 'Ada Example', email: 'ada@example.test' }],
  ['stageChangeEffects', 'pipeline.stage_change', { relationId: 'r1', from: 'APPLICATION_100', to: 'APPROVAL_PENDING_220' }],
  ['api/mentorship', 'mentorship.created', { relationId: 'r1', mentorId: 'u1', menteeId: 'u2', companyId: null }],
  ['api/interactions', 'interaction.logged', { relationId: 'r1', type: 'Feedback', date: at }],
  ['meetingAutoLog', 'interaction.logged', { relationId: 'r1', type: 'Meeting', date: at, autoLogged: true }],
  ['api/evaluations', 'evaluation.added', { relationId: 'r1', type: 'INTERIM', authorId: 'u1' }],
  ['api/meetings', 'meeting.scheduled', { title: 'Weekly', scheduledAt: at, count: 3 }],
  ['api/meetings/instant', 'meeting.scheduled', { title: 'Now', scheduledAt: null, count: 1, instant: true }],
  ['api/meeting-series', 'meeting.scheduled', { title: 'Series', scheduledAt: at, count: 2, seriesId: 's1' }],
  ['api/interview-panels/[id]/score', 'interview_panel.completed', { panelId: 'p1', subjectId: 'u2' }],
  // #1998: the hiring producers.
  ['api/interview-panels/[id]/close', 'interview_panel.completed', { panelId: 'p1', subjectId: 'u2' }],
  ['api/interview-panels/[id]/outcome', 'interview_panel.outcome', { panelId: 'p1', applicationId: 'a1', outcome: 'ADVANCE' }],
  ['api/interview-requests/[id]/schedule', 'interview_request.scheduled', { requestId: 'q1', meetingId: 'm1', scheduledAt: at, panelId: null }],
  ['api/interview-requests/[id]/cancel', 'interview_request.cancelled', { requestId: 'q1', meetingId: null }],
  ['meetingCancel', 'meeting.cancelled', { meetingId: 'm1', scheduledAt: at, count: 3 }],
  ['api/meetings/[id] DELETE', 'meeting.cancelled', { meetingId: 'm1', scheduledAt: null, count: 1 }],
  ['api/meetings/[id] PATCH', 'meeting.rescheduled', { meetingId: 'm1', scheduledAt: at, previousScheduledAt: null }],
  ['applicationStageEvents', 'application.stage_changed', { applicationId: 'a1', requisitionId: 'rq1', from: 'SHORTLISTED', to: 'INTERVIEW' }],
  ['mentorTransfer', 'mentorship.transferred', { relationId: 'r2', previousRelationId: 'r1', menteeId: 'u2', fromMentorId: 'u1', toMentorId: 'u3', mode: 'transferred', reasonCode: 'mentor_capacity' }],
  ['mentorTransfer', 'mentorship.transferred', { relationId: 'r1', previousRelationId: null, menteeId: 'u2', fromMentorId: 'u1', toMentorId: 'u3', mode: 'corrected', reasonCode: 'wrong_assignment' }],
  ['offerEvents (route)', 'offer.sent', { offerId: 'o1', applicationId: null, requisitionId: null }],
  ['offerEvents (route)', 'offer.withdrawn', { offerId: 'o1', applicationId: null, requisitionId: 'rq1' }],
  ['offerEvents (route)', 'offer.accepted', { offerId: 'o1', applicationId: 'a1', requisitionId: 'rq1' }],
  ['offerEvents (route)', 'offer.declined', { offerId: 'o1', applicationId: 'a1', requisitionId: 'rq1' }],
  ['offerEvents (expiry sweep)', 'offer.expired', { offerId: 'o1', applicationId: null, requisitionId: null }],
  ['api/offers/[id]', 'requisition.filled', { requisitionId: 'rq1', offerId: 'o1' }],
];

test.describe('domain-event catalogue', { tag: '@smoke' }, () => {
  test('the public entries are exactly the published webhook list, in order', () => {
    expect([...WEBHOOK_EVENTS]).toEqual(PUBLISHED);
    // webhooks.ts keeps exporting the very same array the catalogue derives.
    expect(REEXPORTED).toBe(WEBHOOK_EVENTS);
  });

  test("every producer's payload validates against its version-1 entry", () => {
    for (const [site, event, payload] of PRODUCERS) {
      const check = validateEventPayload(event, payload, 1);
      expect(check, `${site} → ${event}: ${JSON.stringify(check)}`).toMatchObject({ ok: true });
    }
  });

  test('v1 payloads are strict: an extra key or a missing one is a new version, not a pass', () => {
    expect(validateEventPayload('pipeline.stage_change', { relationId: 'r1', from: 'a', to: 'b', extra: 1 })).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
    expect(validateEventPayload('mentorship.created', { relationId: 'r1', mentorId: 'u1', menteeId: 'u2' })).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
    expect(validateEventPayload('interaction.logged', { relationId: 'r1', type: 'Meeting', date: 'yesterday' })).toMatchObject({
      ok: false,
    });
    expect(validateEventPayload('no.such_event', {})).toEqual({ ok: false, reason: 'unknown_event' });
  });

  test('every entry is well-formed and (name, version) is unique', () => {
    const seen = new Set<string>();
    for (const e of EVENT_CATALOG) {
      const key = `${e.name}@${e.version}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
      expect(e.name.length).toBeLessThanOrEqual(EVENT_NAME_MAX);
      expect(e.name).toMatch(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/);
      expect(Number.isInteger(e.version) && e.version >= 1).toBe(true);
      expect(e.subjectType).toMatch(/^[A-Z][A-Za-z]+$/);
      expect(e.description.trim().length).toBeGreaterThan(0);
    }
  });

  test('the internal events the spine and the outbox need are declared, and never offered as webhooks', () => {
    const internal = [
      'org.config.changed',
      'setting.changed',
      'webhook.registered',
      'apikey.created',
      'apikey.revoked',
      'relation.created',
      'meeting.completed',
      'user.invited',
      'email.bounced',
    ];
    for (const name of internal) {
      expect(DOMAIN_EVENT_NAMES).toContain(name);
      expect(getEventDefinition(name)?.visibility).toBe('internal');
      expect(WEBHOOK_EVENTS as readonly string[]).not.toContain(name);
    }
  });

  test('version lookup and subject extraction', () => {
    expect(latestEventVersion('pipeline.stage_change')).toBe(1);
    expect(latestEventVersion('nope')).toBeNull();
    const def = getEventDefinition('pipeline.stage_change')!;
    expect(eventSubjectId(def, { relationId: 'r9', from: 'a', to: 'b' })).toBe('r9');
    // An event whose v1 payload carries no subject id answers null, not a guess.
    expect(eventSubjectId(getEventDefinition('meeting.scheduled')!, { title: 't', scheduledAt: null, count: 1 })).toBeNull();
  });
});
