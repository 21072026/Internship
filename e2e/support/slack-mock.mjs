// A stand-in for Slack's OAuth endpoint (#1935), used only by the e2e run —
// the google-mock.mjs trick: a local process that speaks the real wire format
// (`POST /oauth.v2.access`, form-encoded, answering `{ ok, access_token, team }`
// or `{ ok: false, error }`), so the app's own half of the install — the
// signed state, the server-side code exchange, the sealing — runs for real and
// CI never calls Slack.
//
// A code starting with `good-` installs team `T<rest>`; anything else is
// `invalid_code`. It records every exchange (without the secret) so the spec
// can assert the client secret was sent and the redirect_uri matched.
import { createServer } from 'node:http';

const PORT = Number(process.env.SLACK_MOCK_PORT || 4606);
const state = { exchanges: [] };

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

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const body = await readBody(req);
  if (url.pathname === '/__state') return json(res, 200, { ok: true, exchanges: state.exchanges.length });
  if (url.pathname === '/__received') return json(res, 200, { exchanges: state.exchanges });
  if (url.pathname === '/oauth.v2.access') {
    const form = new URLSearchParams(body);
    const code = form.get('code') ?? '';
    state.exchanges.push({
      code,
      grantType: form.get('grant_type'),
      redirectUri: form.get('redirect_uri'),
      clientId: form.get('client_id'),
      secretSent: Boolean(form.get('client_secret')),
    });
    if (form.get('grant_type') === 'refresh_token') {
      return json(res, 200, { ok: true, access_token: 'xoxe.xoxb-mock-refreshed', refresh_token: 'xoxe-mock-refresh-2', expires_in: 43200, scope: 'chat:write', team: { id: 'TREFRESH', name: 'Refreshed' } });
    }
    if (!code.startsWith('good-')) return json(res, 200, { ok: false, error: 'invalid_code' });
    const team = code.slice(5);
    return json(res, 200, {
      ok: true,
      access_token: `xoxb-mock-${team}`,
      scope: 'chat:write,im:write,users:read,users:read.email,commands',
      team: { id: `T${team}`, name: `Acme Mock ${team}` },
    });
  }
  return json(res, 404, { ok: false, error: 'unknown_method' });
}).listen(PORT, '127.0.0.1', () => console.log(`slack mock on ${PORT}`));
