// A stand-in for the Have I Been Pwned range API (#1544), used only by the e2e
// run. The same trick as google-mock.mjs / audit-sink.mjs: a local process that
// speaks the real wire format — `GET /range/<5 hex chars>` answering
// `SUFFIX:COUNT` lines — so the app's own half of the lookup (SHA-1, the
// five-character prefix, the local suffix match, the 2 s timeout, failing open)
// runs for real and can be driven into an outage. CI has no business calling
// the real service on every sign-up, and a test must not depend on what the
// real corpus contains today.
//
// It records every request path so the spec can assert the privacy contract
// from the receiver's side: only a 5-character prefix ever arrives, never a
// full hash and never a password. `POST /__outage {on:true}` makes every range
// request answer 503 until switched back.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.HIBP_MOCK_PORT || 4602);

// The passwords this stub "knows" to be breached. `Password123` is the one the
// issue names; the rest are the usual suspects. Nothing an existing spec
// registers with is in here (they use *Pass123 variants).
const BREACHED = { Password123: 3_000_000, password: 10_000_000, '123456': 40_000_000, qwerty: 4_000_000 };

const byPrefix = new Map();
for (const [pw, count] of Object.entries(BREACHED)) {
  const sha = createHash('sha1').update(pw, 'utf8').digest('hex').toUpperCase();
  const prefix = sha.slice(0, 5);
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
  byPrefix.get(prefix).push(`${sha.slice(5)}:${count}`);
}

const state = { outage: false, requests: [] };

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
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const body = await readBody(req);

  if (url.pathname === '/__state') return json(res, 200, { ok: true, outage: state.outage, requests: state.requests.length });
  if (url.pathname === '/__received') return json(res, 200, { requests: state.requests });
  if (url.pathname === '/__reset') {
    state.requests = [];
    state.outage = false;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__outage') {
    state.outage = Boolean(JSON.parse(body || '{}').on);
    return json(res, 200, { ok: true, outage: state.outage });
  }

  const m = /^\/range\/([^/]+)$/.exec(url.pathname);
  if (!m) return json(res, 404, { error: 'not found' });
  const prefix = m[1];
  state.requests.push({ path: url.pathname, prefix, padding: req.headers['add-padding'] ?? null });
  if (state.outage) return json(res, 503, { error: 'hibp stub is down (test outage)' });
  if (!/^[0-9A-Fa-f]{5}$/.test(prefix)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('The hash prefix was not in a valid format');
  }
  // Real rows for the prefix, plus padding rows (count 0) like the real API
  // sends with Add-Padding — a client must not read a padding row as a breach.
  const lines = [...(byPrefix.get(prefix.toUpperCase()) ?? [])];
  for (let i = 0; i < 3; i++) lines.push(`${createHash('sha1').update(`pad-${prefix}-${i}`).digest('hex').toUpperCase().slice(5)}:0`);
  const text = lines.join('\r\n') + '\r\n';
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`hibp mock listening on http://127.0.0.1:${PORT}`);
});
