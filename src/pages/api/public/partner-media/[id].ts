import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/prisma';
import { ASSET_ID_RE } from '@/lib/affiliateLandingRule';

// GET — a picture or video of a public partner page's theme (#3535,
// src/lib/affiliateLandingAssets.ts). Public: the page it decorates is public,
// and the editor previews an upload before the landing is saved, so the id (a
// cuid) is the only key. An id never changes its bytes, hence immutable.
//
// Videos need byte ranges: Safari will not play a <video> whose server ignores
// `Range`. One range is honoured; anything else gets the whole file.
//
// WHY THE PAGES ROUTER (#3732). This is the one route in the tree that is not
// an App Router handler, on purpose: Next 15's App Router response writer
// (`sendResponse`, next/dist/server/send-response.js) drops `Content-Length`
// from every handler response and sends it chunked, and Safari sizes the range
// it asked for from a 206's `Content-Length`. A Pages API route writes to the
// Node response itself, so the length (and this route's own sandboxing CSP,
// which the global header from next.config.js otherwise shadowed) goes out as
// written. Move it back only once an App Router response can carry the header —
// e2e/affiliate-landing-theme.spec.ts asserts it.
export const config = { api: { responseLimit: false } };

const BASE_HEADERS = {
  // Type-checked on upload; nosniff + inline keep the bytes from being read as anything else.
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Accept-Ranges': 'bytes',
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!ASSET_ID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
  // Sessionless: no tenant context is bound; the id is the whole lookup.
  const asset = await prisma.affiliateLandingAsset.findUnique({ where: { id }, select: { contentType: true, data: true } });
  if (!asset) return res.status(404).json({ error: 'Not found' });

  for (const [name, value] of Object.entries(BASE_HEADERS)) res.setHeader(name, value);
  res.setHeader('Content-Type', asset.contentType);
  const bytes = Buffer.from(asset.data);
  const size = bytes.length;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    // `bytes=a-b`, `bytes=a-` (to the end) or `bytes=-n` (the last n bytes).
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    res.status(206);
    return req.method === 'HEAD' ? res.end() : res.end(bytes.subarray(start, end + 1));
  }
  res.setHeader('Content-Length', String(size));
  res.status(200);
  return req.method === 'HEAD' ? res.end() : res.end(bytes);
}
