// A stand-in for the Bot Framework's token authority (#3322), used only by the
// e2e run — the google-mock.mjs trick. It mints an RSA key pair at start, serves
// the OpenID metadata and the JWKS the app reads (TEAMS_OPENID_METADATA_URL
// points here), and signs tokens for the spec on `POST /__sign`, so the app's
// verification — signature, issuer, audience, expiry, serviceUrl — runs for
// real with no secret anywhere. `{ foreign: true }` signs with a key it does
// NOT publish, under a published kid, to prove a forged token is refused.
//
// It also stands in for the two Microsoft endpoints the Teams directory read
// uses (#3327) — the tenant token (`POST /<tenant>/oauth2/v2.0/token`) and
// Graph `GET /v1.0/users`, two users per page with an `@odata.nextLink` — fed
// by the spec through `POST /__graph-users { tenant, users, foreignNextLink }`.
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';

const PORT = Number(process.env.BOTFRAMEWORK_MOCK_PORT || 4607);
const KID = 'e2e-bf-key-1';
const published = generateKeyPairSync('rsa', { modulusLength: 2048 });
const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...published.publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sign(claims, { foreign: useForeign = false, kid = KID, alg = 'RS256' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg, typ: 'JWT', kid })}.${enc(claims)}`;
  const s = createSign('RSA-SHA256');
  s.update(head);
  return `${head}.${s.sign(useForeign ? foreign.privateKey : published.privateKey).toString('base64url')}`;
}

const directories = new Map(); // tenant -> { users, foreignNextLink }

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  if (url.pathname === '/__state') return json(res, 200, { ok: true });
  if (url.pathname === '/openidconfiguration') return json(res, 200, { issuer: 'https://api.botframework.com', jwks_uri: `http://127.0.0.1:${PORT}/keys` });
  if (url.pathname === '/keys') return json(res, 200, { keys: [jwk] });
  if (url.pathname === '/__graph-users' && req.method === 'POST') {
    const { tenant, users, foreignNextLink = false } = JSON.parse(body || '{}');
    directories.set(tenant, { users: users ?? [], foreignNextLink });
    return json(res, 200, { ok: true });
  }
  const tokenPath = /^\/([A-Za-z0-9-]+)\/oauth2\/v2\.0\/token$/.exec(url.pathname);
  if (tokenPath && req.method === 'POST') {
    const form = new URLSearchParams(body);
    if (form.get('grant_type') !== 'client_credentials' || !form.get('client_secret')) return json(res, 400, { error: 'invalid_request' });
    return json(res, 200, { access_token: `graph-mock-${tokenPath[1]}`, expires_in: 3600 });
  }
  if (url.pathname === '/v1.0/users') {
    const tenant = (req.headers.authorization ?? '').replace(/^Bearer graph-mock-/, '');
    const dir = directories.get(tenant);
    if (!dir) return json(res, 401, { error: 'unknown_tenant' });
    const skip = Number(url.searchParams.get('skip') || 0);
    const page = dir.users.slice(skip, skip + 2);
    const more = skip + 2 < dir.users.length;
    const nextLink = more
      ? dir.foreignNextLink
        ? `http://evil.example/v1.0/users?skip=${skip + 2}`
        : `http://127.0.0.1:${PORT}/v1.0/users?skip=${skip + 2}`
      : undefined;
    return json(res, 200, { value: page, ...(nextLink ? { '@odata.nextLink': nextLink } : {}) });
  }
  if (url.pathname === '/__sign' && req.method === 'POST') {
    const { claims, ...opts } = JSON.parse(body || '{}');
    return json(res, 200, { token: sign(claims, opts) });
  }
  return json(res, 404, { error: 'not_found' });
}).listen(PORT, '127.0.0.1', () => console.log(`botframework mock on ${PORT}`));
