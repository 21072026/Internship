'use strict';
// The Internship CRM Zapier app (#2004). Its contract is the public API:
// /api/v1/openapi.json. How it is versioned, tested against a PR environment and
// published is docs/zapier.md in the repository root.
const { version } = require('./package.json');
const { version: platformVersion } = require('zapier-platform-core');
const authentication = require('./authentication');
const middleware = require('./lib/middleware');
const triggers = require('./triggers');
const creates = require('./creates');
const searches = require('./searches');

const byKey = (list) => Object.fromEntries(list.map((item) => [item.key, item]));

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: middleware.befores,
  afterResponse: middleware.afters,
  triggers: byKey(triggers),
  creates: byKey(creates),
  searches: byKey(searches),
  searchOrCreates: {
    find_candidate: {
      key: 'find_candidate',
      display: { label: 'Find or Create Candidate', description: 'Finds a candidate by e-mail, or creates one when none exists.' },
      search: 'find_candidate',
      create: 'create_candidate',
    },
  },
};
