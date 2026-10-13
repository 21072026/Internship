import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productForHost, pushData, registrationKey, registrationReason, shouldAsk, shouldPresent, tapPlan } from './push.ts';
import { PRODUCTS } from './products.ts';

test('pushData keeps a same-site path and a hostname, nothing else', () => {
  assert.deepEqual(pushData({ url: '/messages/c/abc', host: 'InternCRM.com' }), { url: '/messages/c/abc', host: 'interncrm.com' });
  assert.deepEqual(pushData({ url: 'https://evil.example/x', host: 'interncrm.com' }), { url: null, host: 'interncrm.com' });
  assert.deepEqual(pushData({ url: '//evil.example/x', host: 'a b' }), { url: null, host: null });
  assert.deepEqual(pushData({ url: 42, host: { x: 1 } }), { url: null, host: null });
  assert.deepEqual(pushData(null), { url: null, host: null });
  assert.deepEqual(pushData('nope'), { url: null, host: null });
  assert.equal(pushData({ host: 'localhost:3000' }).host, 'localhost:3000');
});

test('productForHost answers only for hosts of this build’s environment', () => {
  assert.equal(productForHost('interncrm.com', PRODUCTS, 'production')?.id, 'internship');
  assert.equal(productForHost('marketing.bcsit-gmbh.de', PRODUCTS, 'production')?.id, 'salevali');
  assert.equal(productForHost('marketing.bcsit-gmbh.dev', PRODUCTS, 'preview')?.id, 'salevali');
  // A production push reaching a preview build belongs to nothing here.
  assert.equal(productForHost('interncrm.com', PRODUCTS, 'preview'), null);
  assert.equal(productForHost('pr123.interncrm.com', PRODUCTS, 'preview'), null);
  assert.equal(productForHost(null, PRODUCTS, 'production'), null);
});

test('tapPlan: same product stays, the other product switches, an unknown host does nothing', () => {
  const data = { url: '/messages/c/abc', host: 'marketing.bcsit-gmbh.de' };
  assert.deepEqual(tapPlan(data, 'salevali', PRODUCTS, 'production'), { switchTo: null, path: '/messages/c/abc' });
  assert.deepEqual(tapPlan(data, 'internship', PRODUCTS, 'production'), { switchTo: 'salevali', path: '/messages/c/abc' });
  // Cold start before a product is chosen: the push names it.
  assert.deepEqual(tapPlan(data, null, PRODUCTS, 'production'), { switchTo: 'salevali', path: '/messages/c/abc' });
  assert.equal(tapPlan({ url: '/messages/c/abc', host: 'evil.example' }, 'internship', PRODUCTS, 'production'), null);
  assert.equal(tapPlan({ url: '/messages/c/abc' }, 'internship', PRODUCTS, 'production'), null);
  assert.deepEqual(tapPlan({ host: 'interncrm.com', url: 'javascript:alert(1)' }, 'internship', PRODUCTS, 'production'), {
    switchTo: null,
    path: null,
  });
});

test('shouldPresent hides the banner only for the thread on screen, in its own product', () => {
  const screen = { host: 'interncrm.com', openThreadId: 'abc' };
  assert.equal(shouldPresent({ host: 'interncrm.com', threadId: 'abc' }, screen), false);
  assert.equal(shouldPresent({ host: 'interncrm.com', threadId: 'other' }, screen), true);
  // Same conversation id can never mean the same thread on another product.
  assert.equal(shouldPresent({ host: 'marketing.bcsit-gmbh.de', threadId: 'abc' }, screen), true);
  assert.equal(shouldPresent({ host: 'interncrm.com', threadId: null }, screen), true);
  assert.equal(shouldPresent({ host: 'interncrm.com', threadId: 'abc' }, { host: 'interncrm.com', openThreadId: null }), true);
});

test('registrationReason: a sign-in or a new token registers; the same token only refreshes', () => {
  const tok = 'ExponentPushToken[aaaaaaaa]';
  assert.equal(registrationReason(null, tok, false), 'register');
  assert.equal(registrationReason('ExponentPushToken[old00000]', tok, false), 'register');
  assert.equal(registrationReason(tok, tok, false), 'refresh');
  assert.equal(registrationReason(tok, tok, true), 'register');
  assert.notEqual(registrationKey('interncrm.com'), registrationKey('marketing.bcsit-gmbh.de'));
});

test('shouldAsk: once per install, never against a permanent refusal', () => {
  assert.equal(shouldAsk({ granted: true, canAskAgain: false }, true), 'granted');
  assert.equal(shouldAsk({ granted: false, canAskAgain: true }, false), 'ask');
  assert.equal(shouldAsk({ granted: false, canAskAgain: true }, true), 'skip');
  assert.equal(shouldAsk({ granted: false, canAskAgain: false }, false), 'skip');
});
