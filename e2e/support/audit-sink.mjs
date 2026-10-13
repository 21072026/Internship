// A stand-in SIEM receiver for the audit stream (#2012), used only by the e2e
// run. The same trick as google-mock.mjs and idp-mock.mjs: a local process that
// speaks the receiver's side of docs/audit-stream.md, so the app's own half —
// the cursor, the signature, the backoff, the replay after an outage, the
// tenant filter — runs for real against something the spec can read back and
// can also make deliberately unavailable.
//
// It records every batch it is handed (headers + raw body) and verifies
// nothing: the SPEC checks the signature with the secret the API returned,
// because that is what a real receiver does, and the sink knowing the secret
// would prove less. `POST /__outage {on:true}` makes every ingest answer 503
// until switched back — the outage the stream must replay across.
//
// The app only speaks to it because playwright.config.ts sets
// AUDIT_DRAIN_ALLOW_INSECURE_RECEIVERS=1 on the app server: a plain-http
// loopback URL is otherwise refused twice (the URL rule, then the SSRF guard).
import { createServer } from 'node:http';

const PORT = Number(process.env.AUDIT_SINK_PORT || 4601);

const state = { received: [], outage: false };

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

  if (url.pathname === '/__state') return json(res, 200, { ok: true, received: state.received.length, outage: state.outage });
  if (url.pathname === '/__received') return json(res, 200, { batches: state.received });
  if (url.pathname === '/__reset') {
    state.received = [];
    state.outage = false;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__outage') {
    state.outage = Boolean(JSON.parse(body || '{}').on);
    return json(res, 200, { ok: true, outage: state.outage });
  }

  // Any other path is a receiver. Two paths let one spec run two tenants'
  // drains side by side and tell their deliveries apart.
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (state.outage) return json(res, 503, { error: 'sink is down (test outage)' });
  state.received.push({
    path: url.pathname,
    at: new Date().toISOString(),
    headers: {
      contentType: req.headers['content-type'] ?? null,
      signature: req.headers['x-signature'] ?? null,
      batchId: req.headers['x-audit-batch-id'] ?? null,
      count: req.headers['x-audit-count'] ?? null,
      format: req.headers['x-audit-format'] ?? null,
      test: req.headers['x-audit-test'] ?? null,
    },
    body,
  });
  return json(res, 202, { ok: true });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`audit sink listening on http://127.0.0.1:${PORT}`);
});
