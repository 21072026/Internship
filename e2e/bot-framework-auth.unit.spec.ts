import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { clearBotFrameworkKeyCache, verifyBotFrameworkRequest } from '@/lib/chat/botFrameworkAuth';

// The Bot Framework JWT check (#3322), without the app: a throwaway JWKS
// server in this process, a key pair minted here, every refusal pinned.

const KID = 'unit-kid';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const APP = 'unit-teams-app';
let server: Server;
let up = true;

function token(claims: Record<string, unknown>, opts: { key?: typeof keys; kid?: string; alg?: string } = {}) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? KID })}.${enc(claims)}`;
  const s = createSign('RSA-SHA256');
  s.update(head);
  return `Bearer ${head}.${s.sign((opts.key ?? keys).privateKey).toString('base64url')}`;
}

const NOW = 1_800_000_000;
const good = { iss: 'https://api.botframework.com', aud: APP, nbf: NOW - 10, exp: NOW + 600, serviceUrl: SERVICE };

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (!up) {
      res.writeHead(503).end();
      return;
    }
    const port = (server.address() as AddressInfo).port;
    const body =
      req.url === '/meta'
        ? { jwks_uri: `http://127.0.0.1:${port}/keys` }
        : { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: KID }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.TEAMS_OPENID_METADATA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/meta`;
  process.env.TEAMS_APP_ID = APP;
});

test.afterAll(async () => {
  delete process.env.TEAMS_OPENID_METADATA_URL;
  delete process.env.TEAMS_APP_ID;
  clearBotFrameworkKeyCache();
  await new Promise<void>((r) => server.close(() => r()));
});

test('a Bot Framework token is accepted only when every claim holds', { tag: '@smoke' }, async () => {
  clearBotFrameworkKeyCache();
  const check = (authorization: string | null, serviceUrl: string | null = SERVICE) =>
    verifyBotFrameworkRequest({ authorization, serviceUrl, nowS: NOW });
  expect(await check(token(good))).toEqual({ ok: true });
  // A trailing slash is the same connector.
  expect(await check(token(good), SERVICE.replace(/\/$/, ''))).toEqual({ ok: true });
  expect(await check(null)).toEqual({ ok: false, reason: 'no_token' });
  expect(await check('Bearer a.b')).toEqual({ ok: false, reason: 'malformed' });
  expect(await check(token(good, { alg: 'HS256' }))).toEqual({ ok: false, reason: 'bad_alg' });
  expect(await check(token(good, { key: other }))).toEqual({ ok: false, reason: 'bad_signature' });
  expect(await check(token(good, { kid: 'nope' }))).toEqual({ ok: false, reason: 'unknown_key' });
  expect(await check(token({ ...good, iss: 'https://evil.example' }))).toEqual({ ok: false, reason: 'bad_issuer' });
  expect(await check(token({ ...good, aud: 'someone-else' }))).toEqual({ ok: false, reason: 'bad_audience' });
  expect(await check(token({ ...good, exp: NOW - 301 }))).toEqual({ ok: false, reason: 'expired' });
  expect(await check(token({ ...good, nbf: NOW + 301 }))).toEqual({ ok: false, reason: 'not_yet_valid' });
  expect(await check(token(good), 'https://other.trafficmanager.net/')).toEqual({ ok: false, reason: 'service_url_mismatch' });
  expect(await check(token({ ...good, serviceUrl: undefined }))).toEqual({ ok: false, reason: 'service_url_mismatch' });
});

test('keys that cannot be fetched refuse the request (fail closed)', { tag: '@smoke' }, async () => {
  clearBotFrameworkKeyCache();
  up = false;
  try {
    expect(await verifyBotFrameworkRequest({ authorization: token(good), serviceUrl: SERVICE, nowS: NOW })).toEqual({
      ok: false,
      reason: 'keys_unavailable',
    });
  } finally {
    up = true;
  }
  const saved = process.env.TEAMS_APP_ID;
  delete process.env.TEAMS_APP_ID;
  expect(await verifyBotFrameworkRequest({ authorization: token(good), serviceUrl: SERVICE, nowS: NOW })).toEqual({
    ok: false,
    reason: 'not_configured',
  });
  process.env.TEAMS_APP_ID = saved;
});
