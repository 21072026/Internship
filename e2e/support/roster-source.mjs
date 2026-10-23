// A stand-in for a tenant's HR export endpoint (#1967), used only by the e2e
// run: the roster feed's HTTPS transport fetches from it, so the console's
// "Run now" runs the whole real path (fetch → hash → parse → diff → apply)
// without the suite depending on the internet. The app server runs with
// ROSTER_FEED_ALLOW_INSECURE_STUB=1, which admits exactly a plain-http
// 127.0.0.1 URL; no deployment sets it.
//
//   POST /__roster  {name, csv}   store a file
//   GET  /roster/<name>.csv       serve it (404 when unknown)
//   GET  /__state                 health check for Playwright's webServer
import { createServer } from 'node:http';

const PORT = Number(process.env.ROSTER_SOURCE_PORT || 4604);
const files = new Map();

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/__state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, files: files.size }));
  }
  if (req.method === 'POST' && url.pathname === '/__roster') {
    const { name, csv } = JSON.parse((await readBody(req)) || '{}');
    files.set(String(name), String(csv));
    res.writeHead(204);
    return res.end();
  }
  const m = /^\/roster\/([\w-]+)\.csv$/.exec(url.pathname);
  if (req.method === 'GET' && m && files.has(m[1])) {
    const body = files.get(m[1]);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => console.log(`[roster-source] listening on ${PORT}`));
