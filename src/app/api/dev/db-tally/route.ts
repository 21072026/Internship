import { NextResponse } from 'next/server';
import { queryTallyEnabled, readQueryTally, resetQueryTally } from '@/lib/dbQueryObserver';
import { requirePermission } from '@/lib/authz';

// The N+1 report's reading of the per-model query tally (#1608) — TEST-ONLY.
//
// Answers 404 unless the server runs with DB_QUERY_TALLY=1, which
// playwright.config.ts sets for the e2e server and nothing else sets; a
// NODE_ENV check would not do, because CI serves a production build. Behind an
// ADMIN session as well: even model names and counts are a map of what a page
// costs, and an unauthenticated reset would let one caller blind another's run.
//
// GET → { total, byModel: [{ model, count }] } since the last reset.
// DELETE → reset to zero.

async function guard(request: Request) {
  if (!queryTallyEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const gate = await requirePermission('analytics.read', { request });
  return 'error' in gate ? gate.error : null;
}

export async function GET(request: Request) {
  // Read BEFORE the session check's own queries land in the tally, so the
  // report shows the page's cost rather than this request's.
  const snapshot = queryTallyEnabled() ? readQueryTally() : null;
  const denied = await guard(request);
  if (denied) return denied;
  return NextResponse.json(snapshot);
}

export async function DELETE(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  resetQueryTally();
  return NextResponse.json({ ok: true });
}
