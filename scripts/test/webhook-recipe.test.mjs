// The webhook verification recipe the /developers page publishes (#1992) must
// accept a real delivery and refuse a forged one. The recipe is EXECUTED here —
// the same string the page renders — against what deliverToWebhook() actually
// sends, so a recipe that drifts from the signer fails this test, not an
// integrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const require = createRequire(import.meta.url);
const { deliverToWebhook } = await import('../../src/lib/webhooks.ts');
const { WEBHOOK_VERIFY_NODE } = await import('../../src/lib/api/webhookRecipe.ts');

const verifyWebhook = new Function('require', `${WEBHOOK_VERIFY_NODE}\nreturn verifyWebhook;`)(require);

test('the published recipe verifies a real delivery and refuses a forged one', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(init);
    return new Response('ok', { status: 200 });
  };
  try {
    const secret = 'whsec_recipe_test';
    // A public IP literal: the SSRF guard needs no DNS for it, so no network is touched.
    await deliverToWebhook({ url: 'https://93.184.215.14/hook', secret }, 'pipeline.stage_change', { relationId: 'r1' }, { deliveryId: 'd-1' });
    assert.equal(sent.length, 1);
    const { body, headers } = sent[0];
    assert.equal(verifyWebhook(secret, body, headers['X-Signature']), true);
    assert.equal(verifyWebhook(secret, Buffer.from(body), headers['X-Signature']), true, 'a raw Buffer body verifies too');
    assert.equal(verifyWebhook('another-secret', body, headers['X-Signature']), false);
    assert.equal(verifyWebhook(secret, body.replace('r1', 'r2'), headers['X-Signature']), false, 'a tampered body is refused');
    assert.equal(verifyWebhook(secret, body, ''), false);
    assert.equal(verifyWebhook(secret, body, undefined), false);
    assert.equal(verifyWebhook(secret, body, 'zz'), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
