import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ASSET_ID_RE } from '@/lib/affiliateLandingRule';

// GET — a picture or video of a public partner page's theme (#3535,
// src/lib/affiliateLandingAssets.ts). Public: the page it decorates is public,
// and the editor previews an upload before the landing is saved, so the id (a
// cuid) is the only key. An id never changes its bytes, hence immutable.
//
// Videos need byte ranges: Safari will not play a <video> whose server ignores
// `Range`. One range is honoured; anything else gets the whole file.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ASSET_ID_RE.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Sessionless: no tenant context is bound; the id is the whole lookup.
  const asset = await prisma.affiliateLandingAsset.findUnique({ where: { id }, select: { contentType: true, size: true, data: true } });
  if (!asset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const headers: Record<string, string> = {
    'Content-Type': asset.contentType,
    // Type-checked on upload; nosniff + inline keep the bytes from being read as anything else.
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
  };
  const bytes = Buffer.from(asset.data);
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  if (range && (range[1] || range[2])) {
    const size = bytes.length;
    // `bytes=a-b`, `bytes=a-` (to the end) or `bytes=-n` (the last n bytes).
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return new NextResponse(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }
    return new NextResponse(bytes.subarray(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new NextResponse(bytes, { headers: { ...headers, 'Content-Length': String(bytes.length) } });
}
