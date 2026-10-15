import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callbackBody, classifySignInError, errorFromCallbackUrl, sessionUserFrom } from './authProtocol.ts';
import { isSameOrigin, originFor, productById, productsFrom } from './products.ts';

test('callback body carries the csrf token and asks for a JSON answer', () => {
  const body = new URLSearchParams(callbackBody({ email: 'a@b.c', password: 'p w&x' }, 'tok', 'https://interncrm.com/'));
  assert.equal(body.get('csrfToken'), 'tok');
  assert.equal(body.get('json'), 'true');
  assert.equal(body.get('password'), 'p w&x');
  assert.equal(body.get('callbackUrl'), 'https://interncrm.com/');
});

test('the error comes back in the url, as next-auth/react reads it', () => {
  assert.equal(errorFromCallbackUrl('https://interncrm.com/api/auth/error?error=2FA_REQUIRED'), '2FA_REQUIRED');
  assert.equal(errorFromCallbackUrl('https://interncrm.com/'), null);
  assert.equal(errorFromCallbackUrl(undefined), 'INVALID');
});

test('server codes map onto app states; unknown codes are never shown raw', () => {
  assert.equal(classifySignInError('2FA_REQUIRED'), 'TWO_FACTOR_REQUIRED');
  assert.equal(classifySignInError('WRONG_WORLD_MARKETING'), 'WRONG_WORLD');
  assert.equal(classifySignInError('Too many attempts. Please try again later.'), 'LOCKED');
  assert.equal(classifySignInError('Invalid authenticator code'), 'BAD_CODE');
  assert.equal(classifySignInError('CredentialsSignin'), 'INVALID');
  assert.equal(classifySignInError("Can't reach database server"), 'INVALID');
});

test('a signed-out session body is no user', () => {
  assert.equal(sessionUserFrom({}), null);
  assert.deepEqual(sessionUserFrom({ user: { id: 'u1', role: 'MENTEE', name: 'A', email: 'a@b.c' } }), {
    id: 'u1', role: 'MENTEE', name: 'A', email: 'a@b.c',
  });
});

test('products: one host per product and environment, and the web view stays on it', () => {
  // Synthetic extra product, as EXPO_PUBLIC_EXTRA_PRODUCTS would add it.
  const products = productsFrom(
    JSON.stringify([
      { id: 'acme', name: 'Acme Sales', color: '#0F766E', hosts: { production: 'marketing.example.test', preview: 'marketing.preview.example.test' } },
    ]),
  );
  assert.equal(products.length, 2);
  const acme = productById('acme', products)!;
  assert.equal(originFor(acme, 'production'), 'https://marketing.example.test');
  assert.equal(originFor(acme, 'preview'), 'https://marketing.preview.example.test');
  assert.equal(isSameOrigin('https://marketing.example.test/messages', 'https://marketing.example.test'), true);
  assert.equal(isSameOrigin('https://interncrm.com/messages', 'https://marketing.example.test'), false);
  assert.equal(isSameOrigin('not a url', 'https://interncrm.com'), false);
  assert.equal(productById('nope', products), null);
});
