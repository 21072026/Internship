import { renderVpat } from '@/lib/vpatRender';
import { vpatDocument } from '@/lib/vpatDocument';
import { VPAT_EVIDENCE } from '@/lib/vpatEvidence.generated';

// The VPAT as a Markdown file, unauthenticated (#2037): procurement fetches it
// without a login and files it next to other vendors' reports. Rendered from the
// same data as the page and docs/legal/vpat.md rather than served from that
// file — Markdown is excluded from the image (.dockerignore), so a static copy
// would not exist at runtime. Public by design: it carries no personal data.
export const dynamic = 'force-static';

export function GET() {
  const body = renderVpat(vpatDocument(), VPAT_EVIDENCE);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'inline; filename="interncrm-vpat-2.5.md"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
