// A stand-in for Google's OAuth token endpoint and Calendar API, used only by
// the e2e run (#709).
//
// WHY THIS EXISTS: the code-for-token exchange and the calendar write are the
// two halves of this integration that cannot be exercised against the real
// Google without a Google Cloud project, live credentials and a human clicking
// a consent screen. That is why the feature sat unfinished. Pointing
// GOOGLE_OAUTH_TOKEN_URL / GOOGLE_CALENDAR_API_BASE at this process turns
// "untestable" into "tested against a stub that speaks Google's wire format":
// the app's own logic — state signing, token sealing, refresh, event
// create/patch/delete, revoke — is fully exercised. What it deliberately does
// NOT prove is that Google accepts our request shapes; only real credentials
// can, which is why the integration still ships behind a default-off flag.
import { createServer } from 'node:http';

const PORT = Number(process.env.GOOGLE_MOCK_PORT || 4599);

// Recorded so a test can assert on what the app sent.
const state = { events: new Map(), revoked: [], seq: 0, freeBusy: { busy: [], fail: false }, freeBusyCalls: 0, conference: { fail: false } };

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

// An unsigned JWT-shaped id_token: the app decodes the payload for a display
// label and explicitly does not verify it (the session already authenticated).
function idToken(email) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ email, email_verified: true })}.`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const body = await readBody(req);

  if (url.pathname === '/token') {
    const params = new URLSearchParams(body);
    const grant = params.get('grant_type');
    if (grant === 'authorization_code') {
      if (params.get('code') === 'bad-code') return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, {
        access_token: 'mock-access-1',
        refresh_token: 'mock-refresh-1',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy openid email',
        id_token: idToken('connected.person@gmail.example'),
      });
    }
    if (grant === 'refresh_token') {
      return json(res, 200, { access_token: 'mock-access-2', expires_in: 3600 });
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }

  if (url.pathname === '/revoke') {
    state.revoked.push(new URLSearchParams(body).get('token'));
    return json(res, 200, {});
  }

  // /calendar/v3/calendars/:id/events[/:eventId]
  const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
  if (m) {
    const [, , eventId] = m;
    if (req.method === 'POST') {
      const event = JSON.parse(body || '{}');
      // A Meet room (#2009): only with conferenceDataVersion=1 and a createRequest,
      // as Google does. /__conference switches it to failing.
      const wantsRoom = url.searchParams.get('conferenceDataVersion') === '1' && event.conferenceData?.createRequest;
      if (wantsRoom && state.conference.fail) return json(res, 503, { error: { message: 'backendError' } });
      const id = `evt-${++state.seq}`;
      if (wantsRoom) {
        const uri = `https://meet.google.com/mock-${state.seq}`;
        event.hangoutLink = uri;
        event.conferenceData = { conferenceId: `mock-${state.seq}`, entryPoints: [{ entryPointType: 'video', uri }] };
      }
      state.events.set(id, event);
      return json(res, 200, { id, status: 'confirmed', ...(wantsRoom ? { hangoutLink: event.hangoutLink, conferenceData: event.conferenceData } : {}) });
    }
    if (req.method === 'PATCH' && eventId) {
      if (!state.events.has(eventId)) return json(res, 404, { error: { message: 'Not Found' } });
      state.events.set(eventId, { ...state.events.get(eventId), ...JSON.parse(body || '{}') });
      return json(res, 200, { id: eventId, status: 'confirmed' });
    }
    if (req.method === 'DELETE' && eventId) {
      state.events.delete(eventId);
      res.writeHead(204);
      return res.end();
    }
  }

  // freeBusy.query (#1997). Busy blocks are set by the spec through
  // /__freebusy; each carries a `summary` Google would never send, so the spec
  // can prove the app drops everything but start/end at the boundary.
  if (url.pathname === '/calendar/v3/freeBusy' && req.method === 'POST') {
    state.freeBusyCalls++;
    if (state.freeBusy.fail) return json(res, 503, { error: { message: 'backendError' } });
    const q = JSON.parse(body || '{}');
    const id = q.items?.[0]?.id ?? 'primary';
    const busy = state.freeBusy.busy.filter((b) => b.start < q.timeMax && b.end > q.timeMin);
    return json(res, 200, { kind: 'calendar#freeBusy', calendars: { [id]: { busy: busy.map((b) => ({ ...b, summary: 'Dentist (private)' })) } } });
  }
  if (url.pathname === '/__conference' && req.method === 'POST') {
    state.conference = { fail: false, ...JSON.parse(body || '{}') };
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__freebusy' && req.method === 'POST') {
    state.freeBusy = { busy: [], fail: false, ...JSON.parse(body || '{}') };
    return json(res, 200, { ok: true });
  }

  // Inspection endpoint for the spec — not part of Google's API.
  if (url.pathname === '/__state') {
    return json(res, 200, {
      events: [...state.events.entries()].map(([id, e]) => ({ id, ...e })),
      revoked: state.revoked,
      freeBusyCalls: state.freeBusyCalls,
    });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`google-mock listening on ${PORT}`));
