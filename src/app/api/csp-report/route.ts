import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logger } from '@/lib/logger';
import { parseCspReports } from '@/lib/cspReport';
import { withRequestScope } from '@/lib/requestContext';

// Where browsers post what the report-only CSP would have blocked (#1552,
// src/lib/cspPolicy.cjs). Anonymous by nature — a browser sends it on its own,
// for any visitor, signed in or not — so it is held to three limits: a rate
// limit per IP (one page view can trigger several reports; a flood gets 429 and
// the browser drops the rest), a body cap, and a log line built ONLY from the
// fields src/lib/cspReport.ts lets through (no query string, no script sample).
// Nothing is stored: the log is the report stream steps 2 and 3 read.

const MAX_BODY = 64 * 1024;

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const limited = enforceRateLimit(request, 'csp-report', { limit: 60, windowMs: 10 * 60 * 1000 });
    if (limited) return limited;

    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY) return new NextResponse(null, { status: 413 });
    const text = (await request.text()).slice(0, MAX_BODY);

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return new NextResponse(null, { status: 400 });
    }

    const seen = new Set<string>();
    for (const v of parseCspReports(payload)) {
      const key = `${v.directive}|${v.blocked}|${v.source}|${v.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      logger.warning('csp.violation', { ...v });
    }
    return new NextResponse(null, { status: 204 });
  });
}
