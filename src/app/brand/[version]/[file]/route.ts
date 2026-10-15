import { prisma } from '@/lib/prisma';
import { brandKindForFile, isBrandVersion } from '@/lib/brandRule';

// An organization's generated brand icons (#2922), served to anyone: they are
// what an installed app, a browser tab, a push notification and an e-mail show,
// none of which carries a session. Outside /api on purpose — these are static
// files in everything but storage, and the middleware's matcher skips any path
// with a dot, so nothing redirects or rewrites them.
//
// What it will and will not answer:
//   - only a well-formed version (16 hex characters, which name no tenant) and
//     only a file name on the allowlist (brandKindForFile): the generated PNG
//     kinds. The stored ORIGINAL — kind `source`, possibly an SVG — is not on
//     it and is never served, so an uploaded SVG cannot reach a browser;
//   - only rows whose stored type is image/png, as a second lock;
//   - by (version, kind) alone. There is no host lookup: the page, the mail or
//     the push payload decided which version to reference, so the same URL
//     works on every host this deployment serves.
//
// A version's bytes never change (a new upload is a new version), so the
// response is cached for a year as immutable — the service worker and every
// browser keep it, and the next upload busts it by changing the path.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ version: string; file: string }> }) {
  const { version, file } = await params;
  const kind = brandKindForFile(file);
  if (!isBrandVersion(version) || !kind) return notFound();

  let row: { data: Uint8Array; contentType: string; size: number } | null = null;
  try {
    row = await prisma.brandAsset.findUnique({
      where: { version_kind: { version, kind } },
      select: { data: true, contentType: true, size: true },
    });
  } catch {
    return new Response('Unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
  }
  if (!row || row.contentType !== 'image/png') return notFound();

  return new Response(Buffer.from(row.data), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(row.data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
