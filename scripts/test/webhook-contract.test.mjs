// The outgoing-webhook contract (#1611): the payload shape of every public
// event, and the signature a receiver verifies.
//
// WHY A COMMITTED FIXTURE
//   The catalogue's zod schemas ARE the producers' contract, so a rename there
//   changes producer and schema together and every other test stays green —
//   while every integrator's parser breaks. The fixture is the receiver's side
//   of the contract, frozen: changing it is a deliberate act in a reviewed
//   diff, and the rule is a new catalogue entry with `version: 2` rather than
//   an edit of version 1 (src/lib/events/catalog.ts, docs/testing.md §
//   Published contracts). Regenerate only for an ADDED event or version:
//     UPDATE_WEBHOOK_CONTRACT=1 npm run test:unit
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { publicEventPayloads, zodToJsonSchema } = await import('../../src/lib/events/payloadSchema.ts');
const { WEBHOOK_EVENTS, deliverToWebhook } = await import('../../src/lib/webhooks.ts');
const { z } = await import('zod');

const FIXTURE = new URL('./fixtures/webhook-payloads.json', import.meta.url);

test('every public event payload matches the committed contract', () => {
  const current = Object.fromEntries(Object.entries(publicEventPayloads()).map(([k, v]) => [k, v.schema]));
  if (process.env.UPDATE_WEBHOOK_CONTRACT === '1') writeFileSync(FIXTURE, `${JSON.stringify(current, null, 2)}\n`);
  const frozen = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  for (const key of Object.keys(frozen)) {
    assert.ok(
      key in current,
      `${key} was published and is gone — a webhook receiver still expects it. Keep the entry; add a version instead.`,
    );
    assert.deepEqual(
      current[key],
      frozen[key],
      `the payload of ${key} changed — that breaks every receiver of this published webhook. Add ${key.replace(/@\d+$/, '')}@<next version> to the catalogue instead of editing this one.`,
    );
  }
  for (const key of Object.keys(current)) {
    assert.ok(key in frozen, `${key} is new: record it with UPDATE_WEBHOOK_CONTRACT=1 npm run test:unit and commit the fixture`);
  }
});

test('every subscribable event has a published payload', () => {
  const published = new Set(Object.keys(publicEventPayloads()).map((k) => k.replace(/@\d+$/, '')));
  for (const event of WEBHOOK_EVENTS) assert.ok(published.has(event), `${event} is subscribable but has no published payload`);
});

test('the converter refuses what it cannot describe instead of publishing "anything"', () => {
  assert.throws(() => zodToJsonSchema(z.any()), /cannot describe zod ZodAny/);
  assert.deepEqual(zodToJsonSchema(z.object({ a: z.string().nullable(), b: z.number().int().positive().optional() }).strict()), {
    type: 'object',
    properties: { a: { type: ['string', 'null'] }, b: { type: 'integer', exclusiveMinimum: 0 } },
    required: ['a'],
    additionalProperties: false,
  });
});

test('a delivery is the documented body, signed with HMAC-SHA256 of exactly that body under the hook secret', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return new Response('ok', { status: 200 });
  };
  try {
    // A public IP literal: the SSRF guard needs no DNS for it, so no network is touched.
    const secret = 'whsec_contract_test';
    const data = { relationId: 'r1', from: 'APPLICATION_100', to: 'APPROVAL_PENDING_220' };
    const res = await deliverToWebhook({ url: 'https://93.184.215.14/hook', secret }, 'pipeline.stage_change', data, { deliveryId: 'd-1' });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    const { init } = sent[0];
    const body = init.body;
    const parsed = JSON.parse(body);
    assert.deepEqual(Object.keys(parsed), ['event', 'data', 'sentAt']);
    assert.equal(parsed.event, 'pipeline.stage_change');
    assert.deepEqual(parsed.data, data);
    assert.ok(!Number.isNaN(Date.parse(parsed.sentAt)));
    assert.equal(init.headers['X-Signature'], createHmac('sha256', secret).update(body).digest('hex'));
    assert.equal(init.headers['X-Event'], 'pipeline.stage_change');
    assert.equal(init.headers['X-Delivery-Id'], 'd-1');
    assert.equal(init.headers['Content-Type'], 'application/json');
    // A different secret must not verify.
    assert.notEqual(init.headers['X-Signature'], createHmac('sha256', 'other').update(body).digest('hex'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
