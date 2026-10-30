// A stand-in for Microsoft's identity platform token endpoint and the Graph
// calendar API, used only by the e2e run (#1991) — the twin of google-mock.mjs.
//
// Pointing MICROSOFT_OAUTH_TOKEN_URL / MICROSOFT_GRAPH_API_BASE at this process
// exercises the app's own half of the integration — state signing, token
// sealing under its own purpose, refresh, event create/patch/delete, the
// account e-mail from /me — with no tenant and no credentials. It does NOT
// prove that Graph accepts our request shapes; only a real tenant can, which is
// why the integration ships behind a default-off flag.
import { createServer } from 'node:http';

const PORT = Number(process.env.MICROSOFT_MOCK_PORT || 4608);

const state = { events: new Map(), seq: 0, tokenRequests: [], fail: false };

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const body = await readBody(req);

  if (url.pathname === '/token' && req.method === 'POST') {
    const params = new URLSearchParams(body);
    const grant = params.get('grant_type');
    state.tokenRequests.push({ grant, scope: params.get('scope') });
    if (grant === 'authorization_code') {
      if (params.get('code') === 'bad-code') return json(res, 400, { error: 'invalid_grant', error_description: 'AADSTS70000' });
      return json(res, 200, {
        token_type: 'Bearer',
        access_token: 'ms-access-1',
        refresh_token: 'ms-refresh-1',
        expires_in: 3600,
        scope: 'offline_access User.Read Calendars.ReadWrite',
      });
    }
    if (grant === 'refresh_token') {
      return json(res, 200, { token_type: 'Bearer', access_token: 'ms-access-2', refresh_token: 'ms-refresh-2', expires_in: 3600 });
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }

  const auth = req.headers.authorization ?? '';
  if (url.pathname.startsWith('/v1.0/') && !auth.startsWith('Bearer ms-access-')) {
    return json(res, 401, { error: { code: 'InvalidAuthenticationToken' } });
  }

  // GET /v1.0/me — the account the consent belongs to. `mail` is empty, as it
  // is for many personal accounts, so the app must fall back to the UPN.
  if (url.pathname === '/v1.0/me' && req.method === 'GET') {
    return json(res, 200, { mail: null, userPrincipalName: 'connected.person@outlook.example' });
  }

  // POST /v1.0/me/events · PATCH|DELETE /v1.0/me/events/:id
  const m = /^\/v1\.0\/me\/events(?:\/([^/]+))?$/.exec(url.pathname);
  if (m && state.fail) return json(res, 503, { error: { code: 'ServiceNotAvailable' } });
  if (m) {
    const [, eventId] = m;
    if (req.method === 'POST' && !eventId) {
      const id = `ms-evt-${++state.seq}`;
      const event = JSON.parse(body || '{}');
      // A Teams meeting (#2009): Graph answers isOnlineMeeting with onlineMeeting.joinUrl.
      if (event.isOnlineMeeting && event.onlineMeetingProvider === 'teamsForBusiness') {
        event.onlineMeeting = { joinUrl: `https://teams.microsoft.com/l/meetup-join/mock-${state.seq}` };
      }
      state.events.set(id, event);
      return json(res, 201, { id, ...(event.onlineMeeting ? { onlineMeeting: event.onlineMeeting } : {}) });
    }
    if (req.method === 'PATCH' && eventId) {
      if (!state.events.has(eventId)) return json(res, 404, { error: { code: 'ErrorItemNotFound' } });
      state.events.set(eventId, { ...state.events.get(eventId), ...JSON.parse(body || '{}') });
      return json(res, 200, { id: eventId });
    }
    if (req.method === 'DELETE' && eventId) {
      state.events.delete(eventId);
      res.writeHead(204);
      return res.end();
    }
  }

  // An outage switch for the spec (POST {"fail": true|false}) — not part of Graph.
  if (url.pathname === '/__fail' && req.method === 'POST') {
    state.fail = !!JSON.parse(body || '{}').fail;
    return json(res, 200, { ok: true });
  }

  // Inspection endpoint for the spec — not part of Graph.
  if (url.pathname === '/__state') {
    return json(res, 200, { events: [...state.events.entries()].map(([id, e]) => ({ id, ...e })), tokenRequests: state.tokenRequests });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`microsoft-mock listening on ${PORT}`));
