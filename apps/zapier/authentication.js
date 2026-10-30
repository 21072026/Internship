'use strict';
// Custom auth: the API key (icrm_…) as a Bearer token. The test is GET
// /api/v1/me, which answers for any live key and says only what the key
// implies — its organisation, scopes and expiry (#2002). The connection label
// is the organisation's name.
const { apiUrl, unwrap } = require('./lib/api');

const test = async (z) => {
  const response = await z.request({ url: apiUrl('/me'), skipThrowForStatus: true });
  return unwrap(z, response);
};

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'API key',
      type: 'password',
      required: true,
      helpText: 'Create a key under Admin › Integrations › API keys (or, for a company or referring organisation, under API keys in your own portal). Give it only the scopes your Zaps need.',
    },
  ],
  test,
  connectionLabel: '{{orgName}}',
};
