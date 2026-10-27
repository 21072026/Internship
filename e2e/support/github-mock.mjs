// A stand-in for the two GitHub REST calls the bug-report "Create GitHub issue"
// button makes (#3132), used only by the e2e run (e2e/support-report-integrations.spec.ts).
// Same trick as klaviyo-mock.mjs: a local process speaking the wire format, so
// no test ever writes to a real repository.
//
//   GET  /repos/:owner/:name          → { private } (POST /__visibility to change)
//   POST /repos/:owner/:name/issues   → 201 { number, html_url }  (401 without a Bearer token)
//
// Control endpoints (never part of the real API):
//   POST /__visibility { private }   what the repo reports
//   POST /__fail { count }           answer the next `count` issue creations 500
//   GET  /__issues                   what was created (title, body, auth header present)
//   GET  /__state                    readiness probe
import { createServer } from 'node:http';

const PORT = Number(process.env.GITHUB_MOCK_PORT || 4605);
let isPrivate = false;
let failNext = 0;
let issues = [];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/__state') return json(res, 200, { ok: true });
  if (url.pathname === '/__issues') return json(res, 200, { issues });
  if (url.pathname === '/__visibility' && req.method === 'POST') { isPrivate = !!(await readBody(req)).private; return json(res, 200, { ok: true }); }
  if (url.pathname === '/__fail' && req.method === 'POST') { failNext = Number((await readBody(req)).count) || 0; return json(res, 200, { ok: true }); }

  const repo = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/issues)?$/);
  if (!repo) return json(res, 404, { message: 'Not Found' });
  const auth = req.headers.authorization ?? '';
  if (!/^Bearer \S+$/.test(auth)) return json(res, 401, { message: 'Bad credentials' });
  if (!repo[3] && req.method === 'GET') return json(res, 200, { full_name: `${repo[1]}/${repo[2]}`, private: isPrivate });
  if (repo[3] && req.method === 'POST') {
    if (failNext > 0) { failNext -= 1; return json(res, 500, { message: 'boom' }); }
    const body = await readBody(req);
    const number = issues.length + 1;
    issues.push({ number, title: body.title, body: body.body });
    return json(res, 201, { number, html_url: `https://github.com/${repo[1]}/${repo[2]}/issues/${number}` });
  }
  return json(res, 405, { message: 'Method Not Allowed' });
}).listen(PORT, '127.0.0.1');
