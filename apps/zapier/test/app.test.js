'use strict';
// Offline tests: every request is answered by nock, so `npm test` needs no key
// and touches no environment. What they pin is the contract with /api/v1: the
// auth test and label, the hook subscribe/unsubscribe cycle, a stable
// Idempotency-Key on every action, and the search's two lookups.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');
const zapier = require('zapier-platform-core');

const BASE = 'https://zapier-test.example';
process.env.ICRM_BASE_URL = BASE;
const App = require('../index');
const appTester = zapier.createAppTester(App);
const authData = { apiKey: 'icrm_test_key' };
// nock hands a request header over as an array of values.
const header = (req, name) => [].concat(req.headers[name])[0];

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

test('the auth test calls /me with the key and labels the connection with the org name', async () => {
  nock(BASE, { reqheaders: { authorization: 'Bearer icrm_test_key' } })
    .get('/api/v1/me')
    .reply(200, { data: { keyId: 'k1', orgId: 'o1', orgName: 'Acme Programme', scopes: ['candidates:read'] } });
  const result = await appTester(App.authentication.test, { authData });
  assert.equal(result.orgName, 'Acme Programme');
  assert.equal(App.authentication.connectionLabel, '{{orgName}}');
});

test('a revoked key fails the auth test with the API\'s problem type', async () => {
  nock(BASE).get('/api/v1/me').reply(401, { type: 'invalid_api_key', title: 'Invalid or missing API key' });
  await assert.rejects(appTester(App.authentication.test, { authData }), /Invalid or missing API key/);
});

test('turning a Zap on subscribes the target to its event; turning it off deletes that subscription', async () => {
  const trigger = App.triggers.offer_accepted.operation;
  nock(BASE)
    .post('/api/v1/hooks', { targetUrl: 'https://hooks.zapier.example/abc', event: 'offer.accepted' })
    .reply(201, { data: { id: 'hook_1', targetUrl: 'https://hooks.zapier.example/abc', event: 'offer.accepted', secret: 's' } });
  const subscribeData = await appTester(trigger.performSubscribe, { authData, targetUrl: 'https://hooks.zapier.example/abc' });
  assert.equal(subscribeData.id, 'hook_1');

  nock(BASE).delete('/api/v1/hooks/hook_1').reply(200, { data: { id: 'hook_1', deleted: true } });
  await appTester(trigger.performUnsubscribe, { authData, subscribeData });
  // An already-removed hook (revoked key, admin delete) is not an error.
  nock(BASE).delete('/api/v1/hooks/hook_1').reply(404, { type: 'not_found' });
  await appTester(trigger.performUnsubscribe, { authData, subscribeData });
  assert.ok(nock.isDone());
});

test('a delivered event becomes one item carrying its data and the delivery id', async () => {
  const items = await appTester(App.triggers.pipeline_stage_changed.operation.perform, {
    authData,
    cleanedRequest: { event: 'pipeline.stage_change', sentAt: '2026-10-30T09:30:00.000Z', data: { relationId: 'r1', from: 'A', to: 'B' } },
    rawRequest: { headers: { 'Http-X-Delivery-Id': 'del_1' } },
  });
  assert.deepEqual(items, [{ id: 'del_1', event: 'pipeline.stage_change', sentAt: '2026-10-30T09:30:00.000Z', relationId: 'r1', from: 'A', to: 'B' }]);
});

test('every trigger has a sample so a Zap can be built before a real event', async () => {
  for (const [key, trigger] of Object.entries(App.triggers)) {
    const list = await appTester(trigger.operation.performList, { authData });
    assert.equal(list.length, 1, key);
    assert.ok(list[0].id, key);
    assert.deepEqual(list[0], trigger.operation.sample, key);
  }
});

test('every action sends an Idempotency-Key that is the same for the same Zap and input, and different for another input', async () => {
  const seen = [];
  const scope = nock(BASE)
    .post('/api/v1/candidates')
    .times(3)
    .reply(function reply() {
      seen.push(header(this.req, 'idempotency-key'));
      return [201, { data: { id: 'c1', fullName: 'Ada Example' } }];
    });
  const bundle = (email) => ({ authData, meta: { zap: { id: 42 } }, inputData: { fullName: 'Ada Example', email, skills: 'TypeScript, SQL' } });
  await appTester(App.creates.create_candidate.operation.perform, bundle('ada@example.test'));
  await appTester(App.creates.create_candidate.operation.perform, bundle('ada@example.test'));
  await appTester(App.creates.create_candidate.operation.perform, bundle('other@example.test'));
  assert.ok(scope.isDone());
  assert.ok(seen.every((k) => typeof k === 'string' && /^zapier-create_candidate-[0-9a-f]{48}$/.test(k)));
  assert.equal(seen[0], seen[1]);
  assert.notEqual(seen[0], seen[2]);

  for (const [key, path, method, inputData] of [
    ['log_interaction', '/api/v1/interactions', 'post', { relationId: 'r1', type: 'Call', date: '2026-10-30T09:30:00Z', notes: 'Talked' }],
    ['update_stage', '/api/v1/relationships/r1/stage', 'patch', { relationId: 'r1', stage: 'INTERVIEW_PENDING_250' }],
  ]) {
    let sent;
    nock(BASE)[method](path).reply(function reply() {
      sent = header(this.req, 'idempotency-key');
      return [200, { data: { id: 'x' } }];
    });
    await appTester(App.creates[key].operation.perform, { authData, meta: { zap: { id: 42 } }, inputData });
    assert.match(sent, new RegExp(`^zapier-${key}-[0-9a-f]{48}$`), key);
  }
});

test('a refused write surfaces the API\'s problem type, not a generic failure', async () => {
  nock(BASE).post('/api/v1/candidates').reply(409, { type: 'duplicate_candidate', title: 'This candidate already exists', detail: 'An account with this e-mail address already exists' });
  await assert.rejects(
    appTester(App.creates.create_candidate.operation.perform, { authData, inputData: { fullName: 'Ada', email: 'ada@example.test' } }),
    /already exists/,
  );
});

test('find_candidate looks up by e-mail or by id; a missing id is an empty result', async () => {
  nock(BASE).get('/api/v1/candidates').query({ email: 'ada@example.test' }).reply(200, { data: [{ id: 'c1' }], page: { nextCursor: null, hasMore: false } });
  assert.deepEqual(await appTester(App.searches.find_candidate.operation.perform, { authData, inputData: { email: 'ada@example.test' } }), [{ id: 'c1' }]);

  nock(BASE).get('/api/v1/candidates/c1').reply(200, { data: { id: 'c1' } });
  assert.deepEqual(await appTester(App.searches.find_candidate.operation.perform, { authData, inputData: { id: 'c1' } }), [{ id: 'c1' }]);

  nock(BASE).get('/api/v1/candidates/nope').reply(404, { type: 'not_found' });
  assert.deepEqual(await appTester(App.searches.find_candidate.operation.perform, { authData, inputData: { id: 'nope' } }), []);
});

test('without ICRM_BASE_URL the app targets preview, never production', () => {
  const saved = process.env.ICRM_BASE_URL;
  delete process.env.ICRM_BASE_URL;
  try {
    const { baseUrl, PREVIEW_URL } = require('../lib/api');
    assert.equal(baseUrl(), PREVIEW_URL);
    assert.match(PREVIEW_URL, /^https:\/\/preview\./);
  } finally {
    process.env.ICRM_BASE_URL = saved;
  }
});
