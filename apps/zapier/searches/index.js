'use strict';
// find_candidate: by id (GET /candidates/{id}) or by exact e-mail
// (GET /candidates?email=, #3452). The e-mail is matched, never returned.
const { apiUrl, unwrap } = require('../lib/api');

const perform = async (z, bundle) => {
  const { id, email } = bundle.inputData;
  if (id) {
    const response = await z.request({ url: apiUrl(`/candidates/${encodeURIComponent(id)}`), skipThrowForStatus: true });
    if (response.status === 404) return [];
    return [unwrap(z, response)];
  }
  if (!email) throw new z.errors.Error('Give a candidate ID or an e-mail address.', 'invalid_input', 400);
  const response = await z.request({ url: apiUrl('/candidates'), params: { email }, skipThrowForStatus: true });
  return unwrap(z, response) || [];
};

module.exports = [
  {
    key: 'find_candidate',
    noun: 'Candidate',
    display: { label: 'Find Candidate', description: 'Finds a candidate by ID or by exact e-mail address.' },
    operation: {
      inputFields: [
        { key: 'email', label: 'E-mail', helpText: 'Exact address; case does not matter.' },
        { key: 'id', label: 'Candidate ID' },
      ],
      perform,
      sample: { id: 'cm_mentee_1', fullName: 'Ada Example', university: 'Example University', department: 'Computer Science', graduationYear: 2027, skills: ['TypeScript'], stage: 'APPLICATION_100', createdAt: '2026-10-30T09:30:00.000Z', updatedAt: '2026-10-30T09:30:00.000Z' },
    },
  },
];
