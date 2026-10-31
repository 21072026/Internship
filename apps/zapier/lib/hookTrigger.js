'use strict';
// One REST-hook trigger per published event (#2002). Turning a Zap on POSTs
// /api/v1/hooks with Zapier's target URL and the event: the subscription is
// owned by the API key the connection uses. Turning it off DELETEs it. Zapier
// receives the signed `{ event, data, sentAt }` body (docs/api-explorer.md);
// the trigger hands Zapier `data`, plus an `id` Zapier dedupes on.
//
// The list step (`performList`) returns the trigger's sample: Zapier calls it
// while a Zap is being built, before any real event exists, and no list
// endpoint returns these exact payload shapes — so a "load more samples" in the
// editor shows the documented shape instead of a different object.
const { apiUrl, unwrap } = require('./api');

function hookTrigger({ key, event, noun, label, description, sample, outputFields }) {
  const performSubscribe = async (z, bundle) => {
    const response = await z.request({
      url: apiUrl('/hooks'),
      method: 'POST',
      body: { targetUrl: bundle.targetUrl, event },
      skipThrowForStatus: true,
    });
    return unwrap(z, response);
  };

  const performUnsubscribe = async (z, bundle) => {
    const id = bundle.subscribeData && bundle.subscribeData.id;
    if (!id) return {};
    const response = await z.request({ url: apiUrl(`/hooks/${encodeURIComponent(id)}`), method: 'DELETE', skipThrowForStatus: true });
    // Already gone (deleted by an admin, or the key was revoked): nothing to undo.
    if (response.status === 404) return {};
    return unwrap(z, response) || {};
  };

  const perform = async (z, bundle) => {
    const body = bundle.cleanedRequest || {};
    const data = body.data || {};
    const headers = (bundle.rawRequest && bundle.rawRequest.headers) || {};
    // X-Delivery-Id is stable across retries of one delivery (#1695) — the
    // right dedupe key. Without it, the event name and the instant it was sent.
    const deliveryId = headers['Http-X-Delivery-Id'] || headers['X-Delivery-Id'];
    return [{ id: deliveryId || `${body.event || event}:${body.sentAt || ''}`, event: body.event || event, sentAt: body.sentAt || null, ...data }];
  };

  return {
    key,
    noun,
    display: { label, description },
    operation: {
      type: 'hook',
      performSubscribe,
      performUnsubscribe,
      perform,
      performList: async () => [sample],
      sample,
      outputFields,
    },
  };
}

module.exports = { hookTrigger };
