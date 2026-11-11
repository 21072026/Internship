'use strict';
// The one place the app knows where the API is and how to talk to it.
//
// BASE URL: `ICRM_BASE_URL` (a Zapier environment variable, `zapier-platform
// env:set <version> ICRM_BASE_URL=…`) and, failing that, the shared PREVIEW
// environment — never production. A reflexive `npm run smoke` or a development
// version pushed without its env set must not touch the live site; the repo
// applies the same rule to its load tests (k6 BASE_URL defaults to preview).
// The promoted, public version is the only one that sets the production URL.
const crypto = require('crypto');

const PREVIEW_URL = 'https://preview.interncrm.com';

function baseUrl() {
  return (process.env.ICRM_BASE_URL || PREVIEW_URL).replace(/\/+$/, '');
}

function apiUrl(path) {
  return `${baseUrl()}/api/v1${path}`;
}

/**
 * A stable Idempotency-Key (#1994) for one write. Zapier re-runs a step it
 * believes failed and replays whole Zap runs; the same Zap with the same input
 * must produce the same key, so the API answers the replay with the first
 * result instead of creating a second row. Derived from the Zap id (when Zapier
 * gives one), the action and its input — never random.
 */
function idempotencyKey(bundle, action) {
  const zapId = (bundle.meta && bundle.meta.zap && bundle.meta.zap.id) || 'nozap';
  const input = JSON.stringify(bundle.inputData || {}, Object.keys(bundle.inputData || {}).sort());
  const digest = crypto.createHash('sha256').update(`${zapId}\n${action}\n${input}`).digest('hex');
  return `zapier-${action}-${digest.slice(0, 48)}`;
}

/** The `data` of a v1 envelope; a problem document becomes a Zapier error naming its type. */
function unwrap(z, response) {
  const body = response.data;
  if (response.status >= 400) {
    const type = (body && body.type) || `http_${response.status}`;
    const detail = (body && (body.detail || body.title)) || 'Request failed';
    throw new z.errors.Error(detail, type, response.status);
  }
  return body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
}

module.exports = { PREVIEW_URL, baseUrl, apiUrl, idempotencyKey, unwrap };
