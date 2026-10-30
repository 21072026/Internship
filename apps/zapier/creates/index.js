'use strict';
// The three actions #2004 asks for. Every one sends an Idempotency-Key derived
// from the Zap and its input (lib/api.js), so a step Zapier retries — or a run
// a user replays — answers with the first result instead of a second row.
const { apiUrl, idempotencyKey, unwrap } = require('../lib/api');

const candidateSample = { id: 'cm_mentee_1', fullName: 'Ada Example', university: 'Example University', department: 'Computer Science', graduationYear: 2027, skills: ['TypeScript'], stage: null, createdAt: '2026-10-30T09:30:00.000Z', updatedAt: '2026-10-30T09:30:00.000Z' };

const write = (action, method, path, bodyOf) => async (z, bundle) => {
  const response = await z.request({
    url: apiUrl(typeof path === 'function' ? path(bundle) : path),
    method,
    body: bodyOf(bundle.inputData),
    headers: { 'Idempotency-Key': idempotencyKey(bundle, action) },
    skipThrowForStatus: true,
  });
  return unwrap(z, response);
};

const skillsOf = (raw) => (Array.isArray(raw) ? raw : String(raw || '').split(','))
  .map((s) => String(s).trim())
  .filter(Boolean);

module.exports = [
  {
    key: 'create_candidate',
    noun: 'Candidate',
    display: { label: 'Create Candidate', description: 'Creates a candidate. An e-mail already in use, or a likely duplicate, is refused unless you allow it.' },
    operation: {
      inputFields: [
        { key: 'fullName', label: 'Full Name', required: true },
        { key: 'email', label: 'E-mail', required: true },
        { key: 'university', label: 'University' },
        { key: 'department', label: 'Department' },
        { key: 'graduationYear', label: 'Graduation Year', type: 'integer' },
        { key: 'skills', label: 'Skills', list: true, helpText: 'One skill per entry, or a comma-separated list.' },
        { key: 'allowPossibleDuplicate', label: 'Create Even If It Looks Like a Duplicate', type: 'boolean', default: 'false' },
      ],
      perform: write('create_candidate', 'POST', '/candidates', (i) => ({
        fullName: i.fullName,
        email: i.email,
        ...(i.university ? { university: i.university } : {}),
        ...(i.department ? { department: i.department } : {}),
        ...(i.graduationYear ? { graduationYear: Number(i.graduationYear) } : {}),
        ...(i.skills ? { skills: skillsOf(i.skills) } : {}),
        ...(String(i.allowPossibleDuplicate) === 'true' ? { allowPossibleDuplicate: true } : {}),
      })),
      sample: candidateSample,
    },
  },
  {
    key: 'log_interaction',
    noun: 'Interaction',
    display: { label: 'Log Interaction', description: 'Logs a meeting, call, e-mail or feedback on a mentorship.' },
    operation: {
      inputFields: [
        { key: 'relationId', label: 'Relationship ID', required: true },
        { key: 'type', label: 'Type', required: true, choices: ['Meeting', 'Feedback', 'Email', 'Call', 'WhatsApp'] },
        { key: 'date', label: 'Date', type: 'datetime', required: true },
        { key: 'subject', label: 'Subject' },
        { key: 'notes', label: 'Notes', type: 'text', required: true },
      ],
      perform: write('log_interaction', 'POST', '/interactions', (i) => ({
        relationId: i.relationId,
        type: i.type,
        date: new Date(i.date).toISOString(),
        notes: i.notes,
        ...(i.subject ? { subject: i.subject } : {}),
      })),
      sample: { id: 'cm_interaction_1', relationId: 'cm_relation_1', type: 'Meeting', date: '2026-10-30T09:30:00.000Z', subject: 'Weekly check-in', createdAt: '2026-10-30T09:31:00.000Z' },
    },
  },
  {
    key: 'update_stage',
    noun: 'Stage',
    display: { label: 'Update Pipeline Stage', description: 'Moves a mentorship to another pipeline stage.' },
    operation: {
      inputFields: [
        { key: 'relationId', label: 'Relationship ID', required: true },
        { key: 'stage', label: 'Stage', required: true, helpText: 'The stage key, e.g. INTERVIEW_PENDING_250.' },
        { key: 'reasonCode', label: 'Reason Code' },
        { key: 'reasonNote', label: 'Reason Note', type: 'text' },
      ],
      perform: write('update_stage', 'PATCH', (bundle) => `/relationships/${encodeURIComponent(bundle.inputData.relationId)}/stage`, (i) => ({
        stage: i.stage,
        ...(i.reasonCode ? { reasonCode: i.reasonCode } : {}),
        ...(i.reasonNote ? { reasonNote: i.reasonNote } : {}),
      })),
      sample: { id: 'cm_relation_1', stage: 'INTERVIEW_PENDING_250', changed: true },
    },
  },
];
