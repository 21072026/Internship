// Unit tests for the partner link's click redirect and counter rule
// (src/lib/affiliateClickRule.ts, docs/affiliate-module.md § Link clicks, #3541).
// Hosts are example hosts only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// affiliateClickRule.ts imports its sibling without an extension; see ts-extensionless-resolve.mjs.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { clickRedirectTarget, isBotUserAgent, isCountableRequest, clickDay, msUntilNextUtcDay, visitorKey, ipKey, CLICK_CODE_RE } =
  await import('../../src/lib/affiliateClickRule.ts');

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const SECRET = 'synthetic-test-secret';

test('a well-formed code goes to the referral URL with ref set — nothing else of the request', () => {
  assert.equal(clickRedirectTarget('https://shop.example/start', 'acme-7'), 'https://shop.example/start?ref=acme-7');
  assert.equal(
    clickRedirectTarget('https://shop.example/auth/registration?utm_source=partner', 'P_12'),
    'https://shop.example/auth/registration?utm_source=partner&ref=P_12',
  );
});

test('a malformed code goes to the bare referral URL, never into it', () => {
  for (const code of ['', '-lead', 'a b', 'x?y=1', 'https://evil.example', '../admin', 'a'.repeat(101), 'ünı']) {
    assert.equal(CLICK_CODE_RE.test(code), false, code);
    assert.equal(clickRedirectTarget('https://shop.example/start', code), 'https://shop.example/start', code);
  }
});

test('no (valid) referral URL means no target — the route sends the visitor home instead', () => {
  assert.equal(clickRedirectTarget(null, 'acme-7'), null);
  assert.equal(clickRedirectTarget('', 'acme-7'), null);
  assert.equal(clickRedirectTarget('http://shop.example/', 'acme-7'), null);
  assert.equal(clickRedirectTarget('https://shop.example/?ref=other', 'acme-7'), null);
  assert.equal(clickRedirectTarget('javascript:alert(1)', 'acme-7'), null);
});

test('bots, link previews, tools and an empty user-agent are not counted', () => {
  for (const ua of [
    null,
    '',
    '   ',
    'Googlebot/2.1 (+http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'WhatsApp/2.23.20.0 A',
    'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'curl/8.4.0',
    'Wget/1.21.4',
    'python-requests/2.31.0',
    'Go-http-client/1.1',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
  ]) {
    assert.equal(isBotUserAgent(ua), true, String(ua));
  }
  assert.equal(isBotUserAgent(BROWSER), false);
  assert.equal(isBotUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'), false);
});

test('only a GET that is not a prefetch is countable', () => {
  assert.equal(isCountableRequest({ method: 'GET', userAgent: BROWSER, purpose: null }), true);
  assert.equal(isCountableRequest({ method: 'HEAD', userAgent: BROWSER, purpose: null }), false);
  assert.equal(isCountableRequest({ method: 'GET', userAgent: BROWSER, purpose: 'prefetch' }), false);
  assert.equal(isCountableRequest({ method: 'GET', userAgent: BROWSER, purpose: 'prefetch;prerender' }), false);
  assert.equal(isCountableRequest({ method: 'GET', userAgent: 'curl/8.4.0', purpose: null }), false);
});

test('the day is the UTC calendar day; a visitor key lives until the next UTC midnight', () => {
  const late = new Date('2026-11-04T23:59:30.000Z');
  assert.equal(clickDay(late).toISOString(), '2026-11-04T00:00:00.000Z');
  assert.equal(msUntilNextUtcDay(late), 30_000);
  assert.equal(clickDay(new Date('2026-11-05T00:00:00.000Z')).toISOString(), '2026-11-05T00:00:00.000Z');
  assert.equal(msUntilNextUtcDay(new Date('2026-11-05T00:00:00.000Z')), 86_400_000);
  assert.ok(msUntilNextUtcDay(new Date('2026-11-04T12:00:00.000Z')) <= 86_400_000);
});

test('the visitor key is a stable hash for one day, and a different one the next day', () => {
  const morning = new Date('2026-11-04T08:00:00Z');
  const evening = new Date('2026-11-04T20:00:00Z');
  const tomorrow = new Date('2026-11-05T08:00:00Z');
  const ip = '203.0.113.7';
  const k = visitorKey(SECRET, morning, ip, BROWSER);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(visitorKey(SECRET, evening, ip, BROWSER), k, 'same day, same visitor');
  assert.notEqual(visitorKey(SECRET, tomorrow, ip, BROWSER), k, 'a new day cannot be linked to the last');
  assert.notEqual(visitorKey(SECRET, morning, '203.0.113.8', BROWSER), k);
  assert.notEqual(visitorKey(SECRET, morning, ip, `${BROWSER} x`), k);
  assert.notEqual(visitorKey('another-secret', morning, ip, BROWSER), k);
  // The limiter's subject is the address alone, hashed the same way.
  assert.equal(ipKey(SECRET, morning, ip), ipKey(SECRET, evening, ip));
  assert.notEqual(ipKey(SECRET, morning, ip), k);
  assert.notEqual(ipKey(SECRET, tomorrow, ip), ipKey(SECRET, morning, ip));
});
