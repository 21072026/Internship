// The webhook signature check the /developers page publishes (#1992). Kept as
// a string so the page shows exactly what scripts/test/webhook-recipe.test.mjs
// executes against a real delivery from deliverToWebhook() — a recipe that
// drifts from the signer fails that test, not an integrator.
export const WEBHOOK_VERIFY_NODE = `const { createHmac, timingSafeEqual } = require('node:crypto');

// rawBody: the request body exactly as received (string or Buffer), before JSON.parse.
function verifyWebhook(secret, rawBody, signatureHeader) {
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const given = Buffer.from(String(signatureHeader || ''), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}`;
