'use strict';
// The five triggers #2004 asks for, each on one published event. Payloads are
// the catalogue's (src/lib/events/catalog.ts, published in /api/v1/openapi.json
// under x-webhooks.payloads) — ids and states, never contact details beyond
// what the event itself carries.
const { hookTrigger } = require('../lib/hookTrigger');

const sent = '2026-10-30T09:30:00.000Z';

module.exports = [
  hookTrigger({
    key: 'new_application',
    event: 'application.created',
    noun: 'Application',
    label: 'New Mentor Application',
    description: 'Triggers when someone applies to a mentor through the public application form.',
    sample: { id: 'sample-application', event: 'application.created', sentAt: sent, mentorId: 'cm_mentor_1', menteeName: 'Ada Example', email: 'ada@example.test' },
    outputFields: [{ key: 'mentorId', label: 'Mentor ID' }, { key: 'menteeName', label: 'Applicant Name' }, { key: 'email', label: 'Applicant E-mail' }],
  }),
  hookTrigger({
    key: 'pipeline_stage_changed',
    event: 'pipeline.stage_change',
    noun: 'Stage Change',
    label: 'Pipeline Stage Changed',
    description: 'Triggers when a mentorship moves to another pipeline stage.',
    sample: { id: 'sample-stage', event: 'pipeline.stage_change', sentAt: sent, relationId: 'cm_relation_1', from: 'APPLICATION_100', to: 'APPROVAL_PENDING_220' },
    outputFields: [{ key: 'relationId', label: 'Relationship ID' }, { key: 'from', label: 'From Stage' }, { key: 'to', label: 'To Stage' }],
  }),
  hookTrigger({
    key: 'offer_accepted',
    event: 'offer.accepted',
    noun: 'Offer',
    label: 'Offer Accepted',
    description: 'Triggers when a candidate accepts an offer.',
    sample: { id: 'sample-offer', event: 'offer.accepted', sentAt: sent, offerId: 'cm_offer_1', applicationId: 'cm_application_1', requisitionId: 'cm_requisition_1' },
    outputFields: [{ key: 'offerId', label: 'Offer ID' }, { key: 'applicationId', label: 'Application ID' }, { key: 'requisitionId', label: 'Requisition ID' }],
  }),
  hookTrigger({
    key: 'meeting_scheduled',
    event: 'meeting.scheduled',
    noun: 'Meeting',
    label: 'Meeting Scheduled',
    description: 'Triggers when meetings are scheduled (a single meeting, a batch or a series).',
    sample: { id: 'sample-meeting', event: 'meeting.scheduled', sentAt: sent, title: 'Weekly check-in', scheduledAt: '2026-11-02T10:00:00.000Z', count: 1 },
    outputFields: [{ key: 'title', label: 'Title' }, { key: 'scheduledAt', label: 'Scheduled At', type: 'datetime' }, { key: 'count', label: 'Meetings', type: 'integer' }],
  }),
  hookTrigger({
    key: 'interview_request_created',
    event: 'interview_request.created',
    noun: 'Interview Request',
    label: 'New Interview Request',
    description: 'Triggers when a company requests an interview with a candidate.',
    sample: { id: 'sample-interview-request', event: 'interview_request.created', sentAt: sent, requestId: 'cm_request_1', requisitionId: 'cm_requisition_1', menteeId: 'cm_mentee_1', companyId: 'cm_company_1' },
    outputFields: [{ key: 'requestId', label: 'Interview Request ID' }, { key: 'requisitionId', label: 'Requisition ID' }, { key: 'menteeId', label: 'Candidate ID' }, { key: 'companyId', label: 'Company ID' }],
  }),
];
